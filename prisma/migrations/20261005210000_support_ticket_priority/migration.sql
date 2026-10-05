-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal';
