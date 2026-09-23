import { prisma } from "../lib/prisma.js";
import { nairaToKobo } from "../lib/crypto.js";
import { monnifyUseMock } from "../lib/env.js";
import {
  listReservedAccountTransactions,
  monnifyAccountReference,
} from "../services/payments/monnify.js";
import { creditFromMonnifyWebhook } from "../services/payments/funding.js";

/** How long a user-created “I've sent” PENDING intent stays before we mark it failed. */
const PENDING_INTENT_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Only poll VAs that had activity / pending intents recently, plus all VAs when few users. */
const VA_POLL_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_VAS_PER_TICK = 25;

function isPaidStatus(status: string) {
  return status === "PAID" || status === "SUCCESS" || status === "COMPLETED";
}

/**
 * Poll Monnify reserved VAs for PAID transfers, credit wallets, expire ghost PENDING intents.
 * Designed for low VA counts (testing / early prod) without relying on the Monnify webhook URL.
 */
export async function runMonnifyVaPollJob() {
  const counts = {
    vasChecked: 0,
    credited: 0,
    alreadyProcessed: 0,
    expired: 0,
    skippedMock: 0,
    errors: 0,
  };

  if (monnifyUseMock()) {
    counts.skippedMock = 1;
    // Still expire ghost intents in mock so the queue doesn't grow forever.
    counts.expired = await expireGhostPendingIntents();
    return counts;
  }

  const since = new Date(Date.now() - VA_POLL_LOOKBACK_MS);

  // Prefer users with a reserved VA who either have recent pending transfer intents
  // or any VA when total reserved accounts is small (≤ MAX_VAS_PER_TICK).
  const pendingUserIds = (
    await prisma.paymentIntent.findMany({
      where: {
        provider: "monnify",
        channel: "transfer",
        status: "PENDING",
        createdAt: { gte: since },
      },
      select: { userId: true },
      distinct: ["userId"],
    })
  ).map((r) => r.userId);

  const totalWithVa = await prisma.user.count({
    where: { monnifyAccountNo: { not: null } },
  });

  const users =
    totalWithVa <= MAX_VAS_PER_TICK
      ? await prisma.user.findMany({
          where: { monnifyAccountNo: { not: null } },
          select: { id: true, monnifyAccountNo: true },
          take: MAX_VAS_PER_TICK,
        })
      : await prisma.user.findMany({
          where: {
            monnifyAccountNo: { not: null },
            ...(pendingUserIds.length
              ? { id: { in: pendingUserIds } }
              : { paymentIntents: { some: { provider: "monnify", createdAt: { gte: since } } } }),
          },
          select: { id: true, monnifyAccountNo: true },
          take: MAX_VAS_PER_TICK,
        });

  for (const user of users) {
    if (!user.monnifyAccountNo) continue;
    counts.vasChecked++;
    try {
      const txns = await listReservedAccountTransactions({
        accountReference: monnifyAccountReference(user.id),
        page: 0,
        size: 20,
      });

      for (const txn of txns) {
        if (!isPaidStatus(txn.paymentStatus)) continue;
        if (!(txn.amountPaidNaira > 0)) continue;

        try {
          const result = await creditFromMonnifyWebhook({
            accountNumber: user.monnifyAccountNo,
            amountKobo: Number(nairaToKobo(txn.amountPaidNaira)),
            transactionReference: txn.transactionReference,
            payerAccountName: txn.customerName ?? undefined,
          });
          if (result.alreadyProcessed) counts.alreadyProcessed++;
          else counts.credited++;

          // Close matching user “I've sent” PENDING ghosts without double-crediting.
          await reconcileUserPendingIntents({
            userId: user.id,
            amountKobo: Number(nairaToKobo(txn.amountPaidNaira)),
            providerRef: txn.transactionReference,
          });
        } catch (err) {
          counts.errors++;
          console.error("[monnify-va-poll] credit failed", user.id, txn.transactionReference, err);
        }
      }
    } catch (err) {
      counts.errors++;
      console.error("[monnify-va-poll] list txns failed", user.id, err);
    }
  }

  counts.expired = await expireGhostPendingIntents();
  return counts;
}

async function reconcileUserPendingIntents(input: {
  userId: string;
  amountKobo: number;
  providerRef: string;
}) {
  const cutoff = new Date(Date.now() - PENDING_INTENT_TTL_MS);
  const pending = await prisma.paymentIntent.findMany({
    where: {
      userId: input.userId,
      provider: "monnify",
      channel: "transfer",
      status: "PENDING",
      amountKobo: BigInt(input.amountKobo),
      createdAt: { gte: cutoff },
      // User-created confirm intents use TRF-… refs, not Monnify MNFY|… refs
      NOT: { reference: input.providerRef },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  for (const intent of pending) {
    const meta = (intent.metadata ?? {}) as Record<string, unknown>;
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "SUCCESS",
        completedAt: new Date(),
        providerRef: input.providerRef,
        metadata: {
          ...meta,
          reconciledByPoll: true,
          monnifyTransactionReference: input.providerRef,
          ledgerVia: input.providerRef,
        },
      },
    });
  }
}

async function expireGhostPendingIntents() {
  const cutoff = new Date(Date.now() - PENDING_INTENT_TTL_MS);
  const result = await prisma.paymentIntent.updateMany({
    where: {
      provider: "monnify",
      channel: "transfer",
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      completedAt: new Date(),
    },
  });
  return result.count;
}
