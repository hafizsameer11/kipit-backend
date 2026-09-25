-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "attachmentUrl" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;

-- AlterTable
ALTER TABLE "SupportTicketMessage" ADD COLUMN IF NOT EXISTS "attachmentUrl" TEXT;
ALTER TABLE "SupportTicketMessage" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;
