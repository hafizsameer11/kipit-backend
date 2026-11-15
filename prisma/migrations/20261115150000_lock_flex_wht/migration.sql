-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('LOCK', 'FLEX');

-- CreateEnum
CREATE TYPE "InterestPayout" AS ENUM ('AT_MATURITY', 'UPFRONT');

-- CreateEnum
CREATE TYPE "RateFamily" AS ENUM ('CALL', 'LOCK', 'FLEX');

-- AlterTable RateBand
ALTER TABLE "RateBand" ADD COLUMN "family" "RateFamily";
ALTER TABLE "RateBand" ADD COLUMN "payout" "InterestPayout";
ALTER TABLE "RateBand" ADD COLUMN "standardTenorDays" INTEGER;

-- AlterTable Placement
ALTER TABLE "Placement" ADD COLUMN "planType" "PlanType";
ALTER TABLE "Placement" ADD COLUMN "interestPayout" "InterestPayout";
ALTER TABLE "Placement" ADD COLUMN "lastTopUpAt" TIMESTAMP(3);
ALTER TABLE "Placement" ADD COLUMN "breakRequestedAt" TIMESTAMP(3);
ALTER TABLE "Placement" ADD COLUMN "breakCreditAt" TIMESTAMP(3);

-- AlterTable Product (Explore WHT per offering)
ALTER TABLE "Product" ADD COLUMN "whtRatePct" DOUBLE PRECISION NOT NULL DEFAULT 10;
