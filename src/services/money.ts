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
  if (call.balanceKobo < amountKobo) {
    throw new AppError(400, "Insufficient Call balance", "INSUFFICIENT_FUNDS");
  }
  return creditWalletFrom({
    userId,
    amountKobo,
    kind: "CALL_WITHDRAW",
    idempotencyKey,
    description: "Call to wallet",
    debitAccountId: call.id,
  });
}

export function interestForPeriod(principalKobo: bigint, rateBps: number, days: number) {
  // simple interest: P * rate * days / 365
  return (principalKobo * BigInt(rateBps) * BigInt(days)) / (10000n * 365n);
}

export { makeReference };
