-- AlterTable
ALTER TABLE "Gift" ADD COLUMN IF NOT EXISTS "recipientEmail" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Gift_recipientEmail_status_idx" ON "Gift"("recipientEmail", "status");
