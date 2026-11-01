import type { JournalKind, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { makeReference } from "../lib/crypto.js";
import { ensureSystemAccount, ensureUserWallet, postJournal } from "./ledger.js";

export { ensureUserWallet, ensureSystemAccount, postJournal, creditWalletDeposit, getWalletBalanceKobo } from "./ledger.js";

export async function ensureUserCall(userId: string) {
  return prisma.ledgerAccount.upsert({
    where: {
      userId_type_currency_tag: { userId, type: "USER_CALL", currency: "NGN", tag: "default" },
    },
    create: { userId, type: "USER_CALL", currency: "NGN", tag: "default", balanceKobo: 0n },
    update: {},
  });
}

export async function debitWallet(input: {
  userId: string;
  amountKobo: bigint;
  kind: JournalKind;
  idempotencyKey: string;
  description?: string;
  creditAccountId: string;
  metadata?: Prisma.InputJsonValue;
}) {
  if (input.amountKobo <= 0n) throw new AppError(400, "Amount must be positive", "INVALID_AMOUNT");
  const wallet = await ensureUserWallet(input.userId);
  if (wallet.balanceKobo < input.amountKobo) {
    throw new AppError(400, "Insufficient wallet balance", "INSUFFICIENT_FUNDS");
  }
  return postJournal({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    lines: [
      { accountId: wallet.id, amountKobo: -input.amountKobo },
      { accountId: input.creditAccountId, amountKobo: input.amountKobo },
    ],
  });
}

export async function creditWalletFrom(input: {
  userId: string;
  amountKobo: bigint;
  kind: JournalKind;
  idempotencyKey: string;
  description?: string;
  debitAccountId: string;
  metadata?: Prisma.InputJsonValue;
}) {
  if (input.amountKobo <= 0n) throw new AppError(400, "Amount must be positive", "INVALID_AMOUNT");
  const wallet = await ensureUserWallet(input.userId);
  return postJournal({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    lines: [
      { accountId: wallet.id, amountKobo: input.amountKobo },
      { accountId: input.debitAccountId, amountKobo: -input.amountKobo },
    ],
  });
}

/** Credit Call Account from a system (or other) debit account — used for daily Call interest. */
export async function creditCallFrom(input: {
  userId: string;
  amountKobo: bigint;
  kind: JournalKind;
  idempotencyKey: string;
  description?: string;
  debitAccountId: string;
  metadata?: Prisma.InputJsonValue;
}) {
  if (input.amountKobo <= 0n) throw new AppError(400, "Amount must be positive", "INVALID_AMOUNT");
  const call = await ensureUserCall(input.userId);
  return postJournal({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    lines: [
      { accountId: call.id, amountKobo: input.amountKobo },
      { accountId: input.debitAccountId, amountKobo: -input.amountKobo },
    ],
  });
}

export async function moveWalletToCall(userId: string, amountKobo: bigint, idempotencyKey: string) {
  const call = await ensureUserCall(userId);
  return debitWallet({
    userId,
    amountKobo,
    kind: "CALL_DEPOSIT",
    idempotencyKey,
    description: "Move to Call Account",
    creditAccountId: call.id,
  });
}

export async function moveCallToWallet(userId: string, amountKobo: bigint, idempotencyKey: string) {
  const call = await ensureUserCall(userId);
  let debit = amountKobo;
  // Max / full-balance moves can overshoot by < ₦1 after client naira rounding.
  if (debit > call.balanceKobo) {
    if (debit - call.balanceKobo <= 100n) {
      debit = call.balanceKobo;
    } else {
      throw new AppError(400, "Insufficient Call balance", "INSUFFICIENT_FUNDS");
    }
  }
  return creditWalletFrom({
    userId,
    amountKobo: debit,
    kind: "CALL_WITHDRAW",
    idempotencyKey,
    description: "Call to wallet",
    debitAccountId: call.id,
  });
}

/**
 * Stored rate scale: percent × 10_000 (4 d.p.). Example: 22.5123% → 225123.
 * Legacy rows used percent × 100; migrate with ×100 before reading.
 */
export const RATE_PCT_SCALE = 10_000;

export function ratePctFromStored(rateStored: number) {
  return rateStored / RATE_PCT_SCALE;
}

export function rateStoredFromPct(ratePct: number) {
  return Math.round(ratePct * RATE_PCT_SCALE);
}

export function interestForPeriod(principalKobo: bigint, rateBps: number, days: number) {
  // P × (rateBps / 10000)% / 100 × days / 365 = P × rateBps × days / (1_000_000 × 365)
  return (principalKobo * BigInt(rateBps) * BigInt(days)) / (1_000_000n * 365n);
}

/** Full-tenor interest; honors SUPER admin exact override when set. */
export function placementInterestKobo(p: {
  principalKobo: bigint;
  rateBps: number;
  tenorDays?: number | null;
  interestOverrideKobo?: bigint | null;
}) {
  if (p.interestOverrideKobo != null) return p.interestOverrideKobo;
  return interestForPeriod(p.principalKobo, p.rateBps, p.tenorDays ?? 0);
}

export { makeReference };
