-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill opening message from existing ticket body
INSERT INTO "SupportTicketMessage" ("id", "ticketId", "author", "body", "createdAt")
SELECT concat('seed_', "id"), "id", 'USER', "body", "createdAt"
FROM "SupportTicket"
WHERE NOT EXISTS (
  SELECT 1 FROM "SupportTicketMessage" m WHERE m."ticketId" = "SupportTicket"."id"
);
