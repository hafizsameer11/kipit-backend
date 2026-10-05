-- Defer approved rate changes until effectiveFrom; track prior rate + apply time.
ALTER TABLE "RateChangeRequest" ADD COLUMN IF NOT EXISTS "previousBps" INTEGER;
ALTER TABLE "RateChangeRequest" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);
