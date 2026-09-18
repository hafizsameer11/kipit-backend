import type { JournalKind, LedgerAccountType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { makeReference } from "../lib/crypto.js";

/** Ensure system clearing + user wallet accounts exist. */
export async function ensureUserWallet(userId: string) {
  return prisma.ledgerAccount.upsert({
    where: {
      userId_type_currency_tag: { userId, type: "USER_WALLET", currency: "NGN", tag: "default" },
    },
    create: { userId, type: "USER_WALLET", currency: "NGN", tag: "default", balanceKobo: 0n },
    update: {},
  });
}

export async function ensureSystemAccount(type: LedgerAccountType) {
  const existing = await prisma.ledgerAccount.findFirst({
    where: { userId: null, type, currency: "NGN", tag: "default" },
  });
  if (existing) return existing;
  return prisma.ledgerAccount.create({
    data: { userId: null, type, currency: "NGN", tag: "default", balanceKobo: 0n },
  });
}

type PostLine = { accountId: string; amountKobo: bigint };

/**
 * Double-entry post: amounts must sum to zero.
 * Positive amountKobo = debit; negative = credit.
 */
export async function postJournal(input: {
  kind: JournalKind;
  description?: string;
  idempotencyKey?: string;
  metadata?: Prisma.InputJsonValue;
  lines: PostLine[];
}) {
  if (input.idempotencyKey) {
    const existing = await prisma.journalEntry.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { lines: true },
    });
    if (existing) return existing;
  }

  const sum = input.lines.reduce((acc, l) => acc + l.amountKobo, 0n);
  if (sum !== 0n) {
    throw new AppError(500, "Journal lines must balance to zero", "LEDGER_UNBALANCED");
  }
  if (input.lines.length < 2) {
    throw new AppError(500, "Journal requires at least two lines", "LEDGER_INVALID");
  }

  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        kind: input.kind,
        reference: makeReference(input.kind),
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        metadata: input.metadata,
        lines: {
          create: input.lines.map((l) => ({
            accountId: l.accountId,
            amountKobo: l.amountKobo,
          })),
        },
      },
      include: { lines: true },
    });

    for (const line of input.lines) {
      // Debit increases asset balance for user wallets in this simple model:
      // we treat USER_WALLET balance as "funds available" and update by -credit/+debit
      // Convention: positive line = debit to account (increase asset), negative = credit (decrease).
      await tx.ledgerAccount.update({
        where: { id: line.accountId },
        data: { balanceKobo: { increment: line.amountKobo } },
      });
    }

    return entry;
  });
}

/** Credit user wallet from system clearing (deposit). amountKobo > 0. */
export async function creditWalletDeposit(input: {
  userId: string;
  amountKobo: bigint;
  idempotencyKey: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  if (input.amountKobo <= 0n) {
    throw new AppError(400, "Deposit amount must be positive", "INVALID_AMOUNT");
  }

  const wallet = await ensureUserWallet(input.userId);
  const clearing = await ensureSystemAccount("SYSTEM_CLEARING");

  return postJournal({
    kind: "DEPOSIT",
    idempotencyKey: input.idempotencyKey,
    description: input.description ?? "Wallet deposit",
    metadata: input.metadata,
    lines: [
      { accountId: wallet.id, amountKobo: input.amountKobo },
      { accountId: clearing.id, amountKobo: -input.amountKobo },
    ],
  });
}

export async function getWalletBalanceKobo(userId: string) {
  const wallet = await ensureUserWallet(userId);
  return wallet.balanceKobo;
}
