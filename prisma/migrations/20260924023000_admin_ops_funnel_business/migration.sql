-- AlterEnum
CREATE TYPE "AccountType" AS ENUM ('PERSONAL', 'BUSINESS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "accountType" "AccountType" NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE "User" ADD COLUMN "businessName" TEXT;
ALTER TABLE "User" ADD COLUMN "businessRcNumber" TEXT;
ALTER TABLE "User" ADD COLUMN "onboardedByAdminId" TEXT;

-- CreateTable
CREATE TABLE "SignupFunnelEvent" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "deviceId" TEXT,
    "step" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupFunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignupFunnelEvent_email_createdAt_idx" ON "SignupFunnelEvent"("email", "createdAt");
CREATE INDEX "SignupFunnelEvent_step_createdAt_idx" ON "SignupFunnelEvent"("step", "createdAt");
CREATE INDEX "SignupFunnelEvent_deviceId_createdAt_idx" ON "SignupFunnelEvent"("deviceId", "createdAt");
CREATE INDEX "SignupFunnelEvent_completed_createdAt_idx" ON "SignupFunnelEvent"("completed", "createdAt");
