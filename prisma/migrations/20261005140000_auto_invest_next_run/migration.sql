-- Schedule fields for auto-invest execution (short + calendar frequencies).
ALTER TABLE "AutoInvestRule" ADD COLUMN IF NOT EXISTS "lastRunAt" TIMESTAMP(3);
ALTER TABLE "AutoInvestRule" ADD COLUMN IF NOT EXISTS "nextRunAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AutoInvestRule_active_nextRunAt_idx" ON "AutoInvestRule"("active", "nextRunAt");
