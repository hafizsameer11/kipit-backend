-- AlterTable
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "ninName" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "ninMatchScore" DOUBLE PRECISION;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "bvnProviderStatus" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "ninProviderStatus" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "providerAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "providerLastError" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "providerReference" TEXT;
ALTER TABLE "KycProfile" ADD COLUMN IF NOT EXISTS "providerCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KycProfile_status_bvnProviderStatus_idx" ON "KycProfile"("status", "bvnProviderStatus");
CREATE INDEX IF NOT EXISTS "KycProfile_status_ninProviderStatus_idx" ON "KycProfile"("status", "ninProviderStatus");
