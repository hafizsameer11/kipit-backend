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
  const interest = interestForPeriod(placement.principalKobo, placement.rateBps, tenorDays);
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

  if (rolledOver) {
    const ratePct = (rolledOver.rateBps / 100).toFixed(1);
    const matures = rolledOver.maturityDate.toISOString().slice(0, 10);
    await createUserNotification({
      userId: placement.userId,
      title: early ? "Plan matured early — rolled over" : "Plan rolled over",
      body: `${placement.name} settled. ₦${payoutNaira.toLocaleString("en-NG")} reinvested at ${ratePct}% p.a. · matures ${matures}.`,
      href: "/portfolio",
      pushKind: "maturity",
      emailKind: "investment",
      amountNaira: payoutNaira,
      emailDetail: early
        ? `${placement.name} · early maturity · rolled over at ${ratePct}% p.a.`
        : `${placement.name} · rolled over at ${ratePct}% p.a. · matures ${matures}`,
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
    ...(rolledOver ? { rolledOverPlacementId: rolledOver.id } : {}),
  };
}
