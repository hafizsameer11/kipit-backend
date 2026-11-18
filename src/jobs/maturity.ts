import { prisma } from "../lib/prisma.js";
import { creditCallFrom, ensureSystemAccount, interestForPeriod } from "../services/money.js";
import { maturePlacement } from "../services/mature-placement.js";

/**
 * Settle fixed plans as soon as their maturity instant has passed.
 * Maturity is startTime + tenorDays (same clock time), not midnight + next-day job.
 */
export async function runDueMaturities() {
  const now = new Date();
  const due = await prisma.placement.findMany({
    where: {
      status: "ACTIVE",
      maturityDate: { not: null, lte: now },
    },
    orderBy: { maturityDate: "asc" },
  });

  let processed = 0;
  let errors = 0;
  for (const p of due) {
    try {
      await maturePlacement({ placementId: p.id, early: false });
      processed++;
    } catch (err) {
      errors++;
      console.error("[maturity] placement failed", p.id, err);
    }
  }

  const { runFlexBreakCredits } = await import("./flex-break.js");
  const flexBreaks = await runFlexBreakCredits();

  return { matured: processed, errors, flexBreaks, asOf: now.toISOString() };
}

/** Daily Call Account interest accrual (Lagos calendar day). */
export async function runDailyCallInterest() {
  const {
    getOpsCutoffs,
    lagosDateKey,
    lagosHmOnDateUtc,
  } = await import("../services/system-settings.js");

  const todayKey = lagosDateKey();
  const [y, mo, d] = todayKey.split("-").map(Number);
  const yesterdayKey = new Date(Date.UTC(y!, mo! - 1, d! - 1)).toISOString().slice(0, 10);
  const { valueDate: valueCutoffHm } = await getOpsCutoffs();
  const valueCutoffAt = lagosHmOnDateUtc(yesterdayKey, valueCutoffHm);

  const callBand = await prisma.rateBand.findFirst({ where: { code: "CALL" } });
  const rateBps = callBand?.rateBps ?? 145_000;
  const callAccounts = await prisma.ledgerAccount.findMany({
    where: { type: "USER_CALL", balanceKobo: { gt: 0 } },
  });
  const interestExpense = await ensureSystemAccount("SYSTEM_INTEREST");
  let callCredits = 0;
  for (const acct of callAccounts) {
    if (!acct.userId) continue;
    const postCutoff = await prisma.journalLine.aggregate({
      where: {
        accountId: acct.id,
        amountKobo: { gt: 0 },
        createdAt: { gte: valueCutoffAt },
        entry: { kind: "CALL_DEPOSIT" },
      },
      _sum: { amountKobo: true },
    });
    const ineligible = postCutoff._sum.amountKobo ?? 0n;
    const eligible = acct.balanceKobo > ineligible ? acct.balanceKobo - ineligible : 0n;
    const daily = interestForPeriod(eligible, rateBps, 1);
    if (daily <= 0n) continue;
    await creditCallFrom({
      userId: acct.userId,
      amountKobo: daily,
      kind: "INTEREST",
      idempotencyKey: `call-interest-${acct.userId}-${todayKey}`,
      description: "Call Account daily interest",
      debitAccountId: interestExpense.id,
    });
    callCredits++;
  }

  return { callCredits, lagosDay: todayKey };
}

/** Full engine: due maturities + (optional) daily call interest. */
export async function runMaturityEngine(opts?: { includeCallInterest?: boolean }) {
  const includeCallInterest = opts?.includeCallInterest !== false;
  const run = await prisma.jobRun.create({
    data: { jobName: "maturity", status: "running" },
  });

  try {
    const due = await runDueMaturities();
    const call = includeCallInterest
      ? await runDailyCallInterest()
      : { callCredits: 0, lagosDay: null as string | null };

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "ok",
        finishedAt: new Date(),
        detail: {
          matured: due.matured,
          errors: due.errors,
          callInterestAccounts: call.callCredits,
          lagosDay: call.lagosDay,
          mode: "maturityInstant<=now",
          asOf: due.asOf,
        },
      },
    });

    return {
      matured: due.matured,
      errors: due.errors,
      callCredits: call.callCredits,
      flexBreaks: due.flexBreaks,
    };
  } catch (err) {
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "error",
        finishedAt: new Date(),
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
    });
    throw err;
  }
}
