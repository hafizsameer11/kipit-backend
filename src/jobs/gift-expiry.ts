import { prisma } from "../lib/prisma.js";
import { refundExpiredGift } from "../services/gifts.js";

const MAX_PER_TICK = 50;

/** Refund unclaimed gifts past expiresAt (and backfill EXPIRED rows with no refund journal). */
export async function runGiftExpiryJob() {
  const now = new Date();
  const pendingDue = await prisma.gift.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: MAX_PER_TICK,
  });

  const backfillIds = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT g.id FROM "Gift" g
    WHERE g.status = 'EXPIRED'
    AND NOT EXISTS (
      SELECT 1 FROM "JournalEntry" j
      WHERE j."idempotencyKey" = 'gift-refund-' || g."claimCode"
    )
    LIMIT 25
  `;
  const backfill =
    backfillIds.length > 0
      ? await prisma.gift.findMany({ where: { id: { in: backfillIds.map((r) => r.id) } } })
      : [];

  const seen = new Set<string>();
  const due = [...pendingDue, ...backfill].filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });

  const counts = { due: due.length, refunded: 0, skipped: 0, errors: 0 };
  for (const gift of due) {
    try {
      const refunded = await refundExpiredGift(gift);
      if (refunded) counts.refunded += 1;
      else counts.skipped += 1;
    } catch (err) {
      counts.errors += 1;
      console.error("[gift-expiry] refund failed", gift.id, err);
    }
  }
  return counts;
}
