import { prisma } from "../lib/prisma.js";

/** Record one impression per account per card. Repeat opens do not add another. */
export async function recordFeedImpressions(userId: string, cardIds: string[]) {
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (!userId || ids.length === 0) return;
  await prisma.feedCardView.createMany({
    data: ids.map((cardId) => ({ cardId, userId })),
    skipDuplicates: true,
  });
}

/**
 * Credit published cards to accounts that already used the app after the card
 * existed, so impressions are not stuck at 0 until the next home open.
 */
export async function backfillFeedImpressions() {
  const cards = await prisma.feedCard.findMany({
    where: { active: true },
    select: { id: true, createdAt: true },
  });
  if (cards.length === 0) return;

  const sessions = await prisma.session.findMany({
    select: { userId: true, lastActiveAt: true },
  });
  const lastByUser = new Map<string, Date>();
  for (const session of sessions) {
    const prev = lastByUser.get(session.userId);
    if (!prev || session.lastActiveAt > prev) lastByUser.set(session.userId, session.lastActiveAt);
  }

  const data: { cardId: string; userId: string }[] = [];
  for (const card of cards) {
    for (const [userId, lastActiveAt] of lastByUser) {
      if (lastActiveAt >= card.createdAt) data.push({ cardId: card.id, userId });
    }
  }
  for (let i = 0; i < data.length; i += 500) {
    await prisma.feedCardView.createMany({
      data: data.slice(i, i + 500),
      skipDuplicates: true,
    });
  }
}
