import { nanoid } from "nanoid";
import type { Placement } from "@prisma/client";
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
  placementInterestKobo,
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
  rolledOverPlacementId?: string;
};

function rateForTenorDays(
  days: number,
  bands: { code: string; minDays: number; maxDays: number | null; rateBps: number }[],
) {
  const band = bands.find((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  if (!band) {
    const fallback = bands.find((b) => b.code !== "CALL") ?? bands[0];
    if (!fallback) throw new AppError(400, "No rate band for tenor", "RATE_BAND_MISSING");
    return fallback;
  }
  return band;
}

type RolloverResult = {
  id: string;
  name: string;
  rateBps: number;
  maturityDate: Date;
};

/**
 * Settle maturity into a new fixed placement (principal + interest) at the
 * prevailing rate for the same tenor. Idempotent via the maturity journal key.
 */
async function settleAsRollover(input: {
  placement: Placement;
  interest: bigint;
  payout: bigint;
  payoutKey: string;
  payoutDesc: string;
  now: Date;
}): Promise<RolloverResult> {
  const { placement, interest, payout, payoutKey, payoutDesc, now } = input;
  const tenorDays = placement.tenorDays ?? 0;

  const existing = await prisma.journalEntry.findUnique({
    where: { idempotencyKey: payoutKey },
  });
  if (existing) {
    const meta = existing.metadata;
    const existingId =
      meta && typeof meta === "object" && meta !== null && "rolledOverPlacementId" in meta
        ? String((meta as { rolledOverPlacementId?: unknown }).rolledOverPlacementId ?? "")
        : "";
    if (existingId) {
      const found = await prisma.placement.findUnique({ where: { id: existingId } });
      if (found) {
        return {
          id: found.id,
          name: found.name,
          rateBps: found.rateBps,
          maturityDate: found.maturityDate ?? now,
        };
      }
    }
    throw new AppError(409, "Maturity already settled", "ALREADY_SETTLED");
  }

  const bands = await prisma.rateBand.findMany();
  const band = rateForTenorDays(tenorDays, bands);
  const maturityDate = new Date(now);
  maturityDate.setDate(maturityDate.getDate() + tenorDays);
  const name = placement.name?.trim() || "Fixed plan";

  const placementTag = `rollover_${nanoid(10)}`;
  const placementAccount = await prisma.ledgerAccount.create({
    data: {
      userId: placement.userId,
      type: "USER_PLACEMENT",
      tag: placementTag,
      currency: "NGN",
      balanceKobo: 0n,
    },
  });

  const newPlacement = await prisma.placement.create({
    data: {
      userId: placement.userId,
      kind: "FIXED",
      name,
      principalKobo: payout,
      rateBps: band.rateBps,
      tenorDays,
      startDate: now,
      maturityDate,
      maturityInstruction: "ROLLOVER",
      productId: placement.productId,
      goalKobo: placement.goalKobo,
      isGift: false,
      ledgerAccountId: placementAccount.id,
    },
  });

  const interestExpense = await ensureSystemAccount("SYSTEM_INTEREST");
  if (placement.ledgerAccountId && interest > 0n) {
    await postJournal({
      kind: "MATURITY",
      idempotencyKey: payoutKey,
      description: payoutDesc,
      metadata: {
        rolledOverPlacementId: newPlacement.id,
        rolledOverFrom: placement.id,
      },
      lines: [
        { accountId: placementAccount.id, amountKobo: payout },
        { accountId: placement.ledgerAccountId, amountKobo: -placement.principalKobo },
        { accountId: interestExpense.id, amountKobo: -interest },
      ],
    });
  } else {
    const debitAccountId =
      placement.ledgerAccountId ?? (await ensureSystemAccount("SYSTEM_CLEARING")).id;
    await postJournal({
      kind: "MATURITY",
      idempotencyKey: payoutKey,
      description: payoutDesc,
      metadata: {
        rolledOverPlacementId: newPlacement.id,
        rolledOverFrom: placement.id,
      },
      lines: [
        { accountId: placementAccount.id, amountKobo: payout },
        { accountId: debitAccountId, amountKobo: -payout },
      ],
    });
  }

  return {
    id: newPlacement.id,
    name: newPlacement.name,
    rateBps: band.rateBps,
    maturityDate,
  };
}

/**
 * Settle a placement. Pays full tenor interest even when early
 * (shorter hold, full profit).
 *
 * Proper ledger (one journal entry → one history row):
 *   USER_WALLET/CALL/new PLACEMENT  +payout
 *   USER_PLACEMENT                   −principal
 *   SYSTEM_INTEREST                  −interest
 *
 * ROLLOVER creates a new fixed plan with principal + interest at the
 * prevailing rate for the same tenor (funds never rest in the wallet).
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
  const interest = placementInterestKobo(placement);
  const payout = placement.principalKobo + interest;
  const early = Boolean(input.early);
  const now = new Date();
  const daysHeld = Math.max(
    0,
    Math.floor((now.getTime() - placement.startDate.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const payoutKey = early ? `early-maturity-${placement.id}` : `maturity-${placement.id}`;
  const payoutDesc = `Maturity payout · ${placement.name}`;

  const isRollover = placement.maturityInstruction === "ROLLOVER" && tenorDays > 0;
  const toCall =
    !isRollover &&
    (placement.maturityInstruction === "PAYOUT" ||
      String(placement.maturityInstruction).toUpperCase() === "CALL");

  let rolledOver: RolloverResult | null = null;

  if (isRollover) {
    try {
      rolledOver = await settleAsRollover({
        placement,
        interest,
        payout,
        payoutKey,
        payoutDesc,
        now,
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : undefined;
      // Only fall back when rollover cannot start (no band) or was already
      // settled to wallet under older code. Mid-flight ledger errors rethrow.
      if (code === "RATE_BAND_MISSING" || code === "ALREADY_SETTLED") {
        console.warn("[mature] rollover unavailable, using wallet", placement.id, code);
      } else {
        throw err;
      }
    }
  }

  if (!rolledOver) {
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
  const { interestBreakdownFromNetAmount } = await import("./wht.js");
  const { displayPlanName } = await import("./lock-flex-rates.js");
  const bd = interestBreakdownFromNetAmount(interest, placement.rateBps);
  const planLabel =
    placement.kind === "FIXED"
      ? displayPlanName(placement.planType ?? "LOCK", placement.tenorDays)
      : placement.name;
  const user = await prisma.user.findUnique({
    where: { id: placement.userId },
    select: { firstName: true },
  });
  const firstName = user?.firstName?.trim() || "there";

  const { sendMaturityEmail } = await import("./notify.js");
  const notifyUser = await prisma.user.findUnique({
    where: { id: placement.userId },
    include: { notificationPrefs: true },
  });

  const maturedOn = placement.maturityDate ?? new Date();
  const totalFmt = payoutNaira.toLocaleString("en-NG");

  if (rolledOver) {
    const ratePct = (rolledOver.rateBps / 10000).toFixed(2);
    const matures = rolledOver.maturityDate.toISOString().slice(0, 10);
    await createUserNotification({
      userId: placement.userId,
      title: `Hooray, ${firstName}!`,
      body: `Your ${tenorDays}-day plan has matured and ₦${totalFmt} has been rolled over into a new ${tenorDays}-day plan at ${ratePct}% p.a., maturing on ${matures}.`,
      href: "/portfolio",
      pushKind: "maturity",
    }).catch(() => undefined);
    if (notifyUser?.email && notifyUser.notificationPrefs?.emailInvestments !== false) {
      await sendMaturityEmail({
        to: notifyUser.email,
        firstName,
        planLabel,
        tenorDays,
        principalNaira: koboToNaira(placement.principalKobo),
        grossInterestNaira: koboToNaira(bd.grossKobo),
        whtNaira: koboToNaira(bd.whtKobo),
        netInterestNaira: koboToNaira(bd.netKobo),
        totalPaidNaira: payoutNaira,
        outcome: "rollover",
        rolloverRatePct: ratePct,
        rolloverMaturityDate: matures,
        maturedOn,
      }).catch(() => undefined);
    }
  } else {
    const destBalance = toCall
      ? await ensureUserCall(placement.userId)
      : await ensureUserWallet(placement.userId);
    const balNaira = koboToNaira(destBalance.balanceKobo);
    const balFmt = balNaira.toLocaleString("en-NG");
    // B15 in-app wording from feedback PDF.
    const body = toCall
      ? `Your ${tenorDays}-day plan has matured. ₦${totalFmt} has been moved to your Call Account, where it will keep earning daily interest. Your Call Account balance is now ₦${balFmt}.`
      : `Your ${tenorDays}-day plan has matured. ₦${totalFmt} (principal + interest) has been paid into your wallet. Your wallet balance is now ₦${balFmt}.`;
    await createUserNotification({
      userId: placement.userId,
      title: `Hooray, ${firstName}!`,
      body,
      href: "/portfolio",
      pushKind: "maturity",
    }).catch(() => undefined);
    if (notifyUser?.email && notifyUser.notificationPrefs?.emailInvestments !== false) {
      await sendMaturityEmail({
        to: notifyUser.email,
        firstName,
        planLabel,
        tenorDays,
        principalNaira: koboToNaira(placement.principalKobo),
        grossInterestNaira: koboToNaira(bd.grossKobo),
        whtNaira: koboToNaira(bd.whtKobo),
        netInterestNaira: koboToNaira(bd.netKobo),
        totalPaidNaira: payoutNaira,
        outcome: toCall ? "call" : "wallet",
        balanceNaira: balNaira,
        maturedOn,
      }).catch(() => undefined);
    }
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
    ...(rolledOver ? { rolledOverPlacementId: rolledOver.id } : {}),
  };
}
