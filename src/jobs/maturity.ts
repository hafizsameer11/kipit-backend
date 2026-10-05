import { prisma } from "../lib/prisma.js";
import { creditCallFrom, ensureSystemAccount, interestForPeriod } from "../services/money.js";
import { maturePlacement } from "../services/mature-placement.js";

export async function runMaturityEngine() {
  const run = await prisma.jobRun.create({
    data: { jobName: "maturity", status: "running" },
  });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const due = await prisma.placement.findMany({
      where: {
        status: "ACTIVE",
        maturityDate: { gte: today, lt: tomorrow },
      },
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

    // Daily call interest — credit Call Account so it compounds (product: daily on Call).
    // Value-date cut-off: CALL_DEPOSIT credits after yesterday's value cut-off are excluded
    // until the next accrual day (interest starts same day only if funded before cut-off).
    const {
      getOpsCutoffs,
      lagosDateKey,
      lagosHmOnDateUtc,
    } = await import("../services/system-settings.js");
    // previousLagosDateKey via nextLagosDateKey inverse
    const todayKey = lagosDateKey();
    const [y, mo, d] = todayKey.split("-").map(Number);
    const yesterdayKey = new Date(Date.UTC(y!, mo! - 1, d! - 1)).toISOString().slice(0, 10);
    const { valueDate: valueCutoffHm } = await getOpsCutoffs();
    const valueCutoffAt = lagosHmOnDateUtc(yesterdayKey, valueCutoffHm);

    const callBand = await prisma.rateBand.findFirst({ where: { code: "CALL" } });
    const rateBps = callBand?.rateBps ?? 1450;
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
      const eligible =
        acct.balanceKobo > ineligible ? acct.balanceKobo - ineligible : 0n;
      const daily = interestForPeriod(eligible, rateBps, 1);
      if (daily <= 0n) continue;
      await creditCallFrom({
        userId: acct.userId,
        amountKobo: daily,
        kind: "INTEREST",
        idempotencyKey: `call-interest-${acct.userId}-${today.toISOString().slice(0, 10)}`,
        description: "Call Account daily interest",
        debitAccountId: interestExpense.id,
      });
      callCredits++;
    }

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "ok",
        finishedAt: new Date(),
        detail: { matured: processed, errors, callInterestAccounts: callCredits },
      },
    });

    return { matured: processed, errors, callCredits };
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
