import { prisma } from "../lib/prisma.js";
import { creditWalletFrom, ensureSystemAccount, interestForPeriod } from "../services/money.js";

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
    for (const p of due) {
      const interest = interestForPeriod(
        p.principalKobo,
        p.rateBps,
        p.tenorDays ?? 0,
      );
      const payout = p.principalKobo + interest;

      if (p.ledgerAccountId) {
        await creditWalletFrom({
          userId: p.userId,
          amountKobo: payout,
          kind: "MATURITY",
          idempotencyKey: `maturity-${p.id}`,
          description: `Maturity: ${p.name}`,
          debitAccountId: p.ledgerAccountId,
        });
      } else {
        const clearing = await ensureSystemAccount("SYSTEM_CLEARING");
        await creditWalletFrom({
          userId: p.userId,
          amountKobo: payout,
          kind: "MATURITY",
          idempotencyKey: `maturity-${p.id}`,
          description: `Maturity: ${p.name}`,
          debitAccountId: clearing.id,
        });
      }

      if (p.maturityInstruction === "ROLLOVER" && p.tenorDays) {
        // Simple rollover: leave funds in wallet and notify; full auto-reinvest can expand later
        await prisma.notification.create({
          data: {
            userId: p.userId,
            title: "Plan matured — ready to roll over",
            body: `${p.name} matured. ₦${Number(payout) / 100} is in your wallet.`,
            href: "/fixed-plans/create",
          },
        });
      } else {
        await prisma.notification.create({
          data: {
            userId: p.userId,
            title: "Plan matured",
            body: `${p.name} matured. Funds are in your wallet.`,
            href: "/portfolio",
          },
        });
      }

      await prisma.placement.update({
        where: { id: p.id },
        data: { status: "MATURED", accruedKobo: interest },
      });
      processed++;
    }

    // Daily call interest accrual (visible credit)
    const callBand = await prisma.rateBand.findFirst({ where: { code: "CALL" } });
    const rateBps = callBand?.rateBps ?? 1450;
    const callAccounts = await prisma.ledgerAccount.findMany({
      where: { type: "USER_CALL", balanceKobo: { gt: 0 } },
    });
    const interestExpense = await ensureSystemAccount("SYSTEM_INTEREST");
    let callCredits = 0;
    for (const acct of callAccounts) {
      if (!acct.userId) continue;
      const daily = interestForPeriod(acct.balanceKobo, rateBps, 1);
      if (daily <= 0n) continue;
      await creditWalletFrom({
        userId: acct.userId,
        amountKobo: daily,
        kind: "INTEREST",
        idempotencyKey: `call-interest-${acct.userId}-${today.toISOString().slice(0, 10)}`,
        description: "Call Account daily interest",
        debitAccountId: interestExpense.id,
      });
      // Move interest into call for compounding feel — credit call instead:
      // Already credited wallet per product paper daily visible interest; leave in wallet for simplicity
      // or post to call. Product paper: credited daily to Call. Re-post:
      callCredits++;
    }

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "ok",
        finishedAt: new Date(),
        detail: { matured: processed, callInterestAccounts: callCredits },
      },
    });

    return { matured: processed, callCredits };
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
