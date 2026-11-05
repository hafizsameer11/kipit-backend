-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('SUBMITTED', 'PROCESSING', 'REJECTED', 'DELETED');

-- CreateTable
CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonDetail" TEXT,
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "rejectionReason" TEXT,
    "scheduledPurgeAt" TIMESTAMP(3) NOT NULL,
    "processedByAdminId" TEXT,
    "processedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_status_idx" ON "AccountDeletionRequest"("status");

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_userId_status_idx" ON "AccountDeletionRequest"("userId", "status");

-- AddForeignKey
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
