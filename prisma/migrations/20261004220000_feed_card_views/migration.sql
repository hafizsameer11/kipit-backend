-- Unique account impressions for published home-feed cards.
CREATE TABLE "FeedCardView" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedCardView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedCardView_cardId_userId_key" ON "FeedCardView"("cardId", "userId");
CREATE INDEX "FeedCardView_cardId_idx" ON "FeedCardView"("cardId");

ALTER TABLE "FeedCardView" ADD CONSTRAINT "FeedCardView_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "FeedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedCardView" ADD CONSTRAINT "FeedCardView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Accounts that already opened the app after a card existed have seen it on home.
INSERT INTO "FeedCardView" ("id", "cardId", "userId", "createdAt")
SELECT
    md5(c."id" || ':' || s."userId"),
    c."id",
    s."userId",
    CURRENT_TIMESTAMP
FROM "FeedCard" c
JOIN (
    SELECT "userId", MAX("lastActiveAt") AS "lastActiveAt"
    FROM "Session"
    GROUP BY "userId"
) s ON s."lastActiveAt" >= c."createdAt"
WHERE c."active" = true;
