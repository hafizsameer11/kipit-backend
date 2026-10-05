import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { koboToNaira } from "../lib/crypto.js";
import {
  creditCallFrom,
  creditWalletFrom,
  ensureSystemAccount,
  ensureUserCall,
  ensureUserWallet,
  interestForPeriod,
} from "./money.js";
import { postJournal } from "./ledger.js";
import { createUserNotification } from "./notify.js";

export type MaturePlacementResult = {
  id: string;
  name: string;
  principal: number;
  interest: number;
  payout: number;
  early: boolean;
  daysHeld: number;
  tenorDays: number;
};

/**
 * Settle a placement. Pays full tenor interest even when early
 * (shorter hold, full profit).
 *
 * Proper ledger (one journal entry → one history row):
 *   USER_WALLET/CALL  +payout
 *   USER_PLACEMENT    −principal
 *   SYSTEM_INTEREST   −interest
 */
export async function maturePlacement(input: {
  placementId: string;
  early?: boolean;
}): Promise<MaturePlacementResult> {
  const placement = await prisma.placement.findUnique({
    where: { id: input.placementId },
  });
  if (!placement) throw new AppError(404, "Placement not found", "NOT_FOUND");
  if (placement.status !== "ACTIVE") {
    throw new AppError(400, "Placement is not active", "NOT_ACTIVE");
  }

  const tenorDays = placement.tenorDays ?? 0;
  const interest = interestForPeriod(placement.principalKobo, placement.rateBps, tenorDays);
  const payout = placement.principalKobo + interest;
  const early = Boolean(input.early);
  const now = new Date();
  const daysHeld = Math.max(
    0,
    Math.floor((now.getTime() - placement.startDate.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const payoutKey = early ? `early-maturity-${placement.id}` : `maturity-${placement.id}`;
  const payoutDesc = early
    ? `Early maturity: ${placement.name}`
    : `Maturity: ${placement.name}`;

  const toCall =
    placement.maturityInstruction === "PAYOUT" ||
    String(placement.maturityInstruction).toUpperCase() === "CALL";

  if (placement.ledgerAccountId && interest > 0n) {
    const destination = toCall
      ? await ensureUserCall(placement.userId)
      : await ensureUserWallet(placement.userId);
    const interestExpense = await ensureSystemAccount("SYSTEM_INTEREST");
    await postJournal({
      kind: "MATURITY",
      idempotencyKey: payoutKey,
      description: payoutDesc,
      lines: [
        { accountId: destination.id, amountKobo: payout },
        { accountId: placement.ledgerAccountId, amountKobo: -placement.principalKobo },
        { accountId: interestExpense.id, amountKobo: -interest },
      ],
    });
  } else if (placement.ledgerAccountId) {
    if (toCall) {
      await creditCallFrom({
        userId: placement.userId,
        amountKobo: payout,
        kind: "MATURITY",
        idempotencyKey: payoutKey,
        description: payoutDesc,
        debitAccountId: placement.ledgerAccountId,
      });
    } else {
      await creditWalletFrom({
        userId: placement.userId,
        amountKobo: payout,
        kind: "MATURITY",
        idempotencyKey: payoutKey,
        description: payoutDesc,
        debitAccountId: placement.ledgerAccountId,
      });
    }
  } else {
    const clearing = await ensureSystemAccount("SYSTEM_CLEARING");
    if (toCall) {
      await creditCallFrom({
        userId: placement.userId,
        amountKobo: payout,
        kind: "MATURITY",
        idempotencyKey: payoutKey,
        description: payoutDesc,
        debitAccountId: clearing.id,
      });
    } else {
      await creditWalletFrom({
        userId: placement.userId,
        amountKobo: payout,
        kind: "MATURITY",
        idempotencyKey: payoutKey,
        description: payoutDesc,
        debitAccountId: clearing.id,
      });
    }
  }

  await prisma.placement.update({
    where: { id: placement.id },
    data: {
      status: "MATURED",
      accruedKobo: interest,
      ...(early ? { maturityDate: now } : {}),
    },
  });

  const payoutNaira = koboToNaira(payout);
  const interestNaira = koboToNaira(interest);

  if (placement.maturityInstruction === "ROLLOVER" && tenorDays > 0) {
    await createUserNotification({
      userId: placement.userId,
      title: early ? "Plan matured early — ready to roll over" : "Plan matured — ready to roll over",
      body: `${placement.name} settled. ₦${payoutNaira.toLocaleString("en-NG")} is in your wallet.`,
      href: "/fixed-plans/create",
      pushKind: "maturity",
    }).catch(() => undefined);
  } else {
    await createUserNotification({
      userId: placement.userId,
      title: early ? "Plan matured early" : "Plan matured",
      body: `${placement.name} settled. ₦${payoutNaira.toLocaleString("en-NG")} credited${toCall ? " to Call Account" : " to your wallet"}.`,
      href: "/portfolio",
      pushKind: "maturity",
      emailKind: "investment",
      amountNaira: payoutNaira,
      emailDetail: early
        ? `${placement.name} · early maturity · ${daysHeld}d held · full ${tenorDays}d interest`
        : `${placement.name} · matured`,
    }).catch(() => undefined);
  }

  return {
    id: placement.id,
    name: placement.name,
    principal: koboToNaira(placement.principalKobo),
    interest: interestNaira,
    payout: payoutNaira,
    early,
    daysHeld,
    tenorDays,
  };
}
