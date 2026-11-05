import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import {
  ACCOUNT_DELETION_HOLD_DAYS,
  ACCOUNT_DELETION_REASON_LABELS,
  type AccountDeletionReasonCode,
} from "../lib/account-deletion.js";
import type { AccountDeletionRequest, AccountDeletionStatus } from "@prisma/client";

export function scheduledPurgeAtFrom(now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + ACCOUNT_DELETION_HOLD_DAYS);
  return d;
}

export function serializeDeletionRequest(row: AccountDeletionRequest) {
  const code = row.reasonCode as AccountDeletionReasonCode;
  return {
    id: row.id,
    status: row.status,
    reasonCode: row.reasonCode,
    reasonLabel: ACCOUNT_DELETION_REASON_LABELS[code] ?? row.reasonCode,
    reasonDetail: row.reasonDetail,
    rejectionReason: row.rejectionReason,
    scheduledPurgeAt: row.scheduledPurgeAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    canResubmit: row.status === "REJECTED",
    canMarkDeleted: row.status === "PROCESSING" || row.status === "SUBMITTED",
  };
}

export async function findOpenDeletionRequest(userId: string) {
  return prisma.accountDeletionRequest.findFirst({
    where: { userId, status: { in: ["SUBMITTED", "PROCESSING"] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function assertDeletionEligibleForSoftDelete(userId: string) {
  const [wallet, call, activePlacements, pendingWithdrawals] = await Promise.all([
    prisma.ledgerAccount.findFirst({
      where: { userId, type: "USER_WALLET" },
      select: { balanceKobo: true },
    }),
    prisma.ledgerAccount.findFirst({
      where: { userId, type: "USER_CALL" },
      select: { balanceKobo: true },
    }),
    prisma.placement.count({
      where: { userId, status: "ACTIVE", kind: { in: ["FIXED", "EXPLORE"] } },
    }),
    prisma.withdrawalRequest.count({
      where: { userId, status: "PROCESSING" },
    }),
  ]);

  const walletKobo = wallet?.balanceKobo ?? 0n;
  const callKobo = call?.balanceKobo ?? 0n;
  const blockers: string[] = [];
  if (walletKobo > 0n) blockers.push(`Wallet balance ₦${Number(walletKobo) / 100} must be zero`);
  if (callKobo > 0n) blockers.push(`Call balance ₦${Number(callKobo) / 100} must be zero`);
  if (activePlacements > 0) blockers.push(`${activePlacements} active investment(s) must be closed or matured`);
  if (pendingWithdrawals > 0) blockers.push(`${pendingWithdrawals} withdrawal(s) still processing`);

  if (blockers.length) {
    throw new AppError(
      400,
      `Cannot mark deleted until checks clear: ${blockers.join("; ")}`,
      "DELETION_BLOCKED",
    );
  }
}

/** Soft-delete: keep User row; free unique identifiers for reuse. */
export async function softAnonymizeUser(userId: string, adminId?: string) {
  await assertDeletionEligibleForSoftDelete(userId);

  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { userId } });
    await tx.pushDevice.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        phone: null,
        googleSub: null,
        passwordHash: null,
        pinHash: null,
        biometricsLogin: false,
        biometricsTxn: false,
        referralCode: `del-${nanoid(12)}`,
        frozen: true,
        frozenReason: "Account deletion completed",
        firstName: "Deleted",
        surname: "User",
        middleName: null,
        monnifyAccountNo: null,
        monnifyBankName: null,
      },
    });
  });

  return { userId, adminId };
}

export function assertCanTransition(
  from: AccountDeletionStatus,
  to: AccountDeletionStatus,
) {
  const allowed: Record<AccountDeletionStatus, AccountDeletionStatus[]> = {
    SUBMITTED: ["PROCESSING", "REJECTED", "DELETED"],
    PROCESSING: ["REJECTED", "DELETED"],
    REJECTED: [],
    DELETED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new AppError(400, `Cannot move from ${from} to ${to}`, "INVALID_STATE");
  }
}
