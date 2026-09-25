import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "./audit.js";
import { sendBrandedNoticeEmail } from "./email.js";
import type { PremblyPerson } from "./prembly.js";

/** Demo BVN used in local mock flows (seed / sandbox UX). */
export const DEMO_BVN = "22123456789";

export function normalizeName(s: string) {
  return s
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export function fuzzyScore(a: string, b: string) {
  const aa = new Set(normalizeName(a).split(" "));
  const bb = new Set(normalizeName(b).split(" "));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return hit / Math.max(aa.size, bb.size);
}

export function formatPremblyName(person: PremblyPerson) {
  return person.fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.toUpperCase())
    .join(" ");
}

export async function getKycStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const profile =
    (await prisma.kycProfile.findUnique({ where: { userId } })) ??
    (await prisma.kycProfile.create({ data: { userId } }));

  return {
    tier: user.kycTier,
    status: profile.status,
    profile: {
      bvn: profile.bvn ? profile.bvn.replace(/\d(?=\d{4})/g, "•") : null,
      bvnName: profile.bvnName,
      nin: profile.nin ? "••••••••••" + profile.nin.slice(-3) : null,
      ninName: profile.ninName,
      livenessPassed: profile.livenessPassed,
      hasSelfie: Boolean(profile.selfieUrl),
      hasAddressDoc: Boolean(profile.addressDocUrl),
      occupation: user.occupation,
      employmentStatus: user.employmentStatus,
      sourceOfFunds: user.sourceOfFunds,
      rejectionReason: profile.rejectionReason,
      provider: profile.provider,
      bvnProviderStatus: profile.bvnProviderStatus,
      ninProviderStatus: profile.ninProviderStatus,
    },
  };
}

/**
 * Queue BVN for async Prembly verification (worker job).
 * Returns immediately with pending:true — never calls Prembly inline.
 */
export async function submitBvn(userId: string, bvn: string) {
  if (!/^\d{11}$/.test(bvn)) throw new AppError(400, "BVN must be 11 digits", "BVN_INVALID");

  const profile = await prisma.kycProfile.upsert({
    where: { userId },
    create: {
      userId,
      bvn,
      bvnName: null,
      bvnMatchScore: null,
      status: "PENDING_REVIEW",
      provider: "prembly",
      bvnProviderStatus: "PENDING",
      providerAttempts: 0,
      providerLastError: null,
      providerReference: null,
      providerCheckedAt: null,
      rejectionReason: null,
    },
    update: {
      bvn,
      bvnName: null,
      bvnMatchScore: null,
      status: "PENDING_REVIEW",
      provider: "prembly",
      bvnProviderStatus: "PENDING",
      providerAttempts: 0,
      providerLastError: null,
      providerReference: null,
      providerCheckedAt: null,
      rejectionReason: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    },
  });

  await writeAudit({
    actorUserId: userId,
    action: "kyc.bvn_queued",
    entityType: "KycProfile",
    entityId: profile.id,
    after: { provider: "prembly" },
  });

  return {
    match: "pending" as const,
    score: 0,
    bvnName: "Pending verification",
    profileId: profile.id,
    pending: true,
  };
}

/**
 * Legacy confirm step. With async Prembly, Tier 1 is granted by the job.
 * Kept so older app builds don't break if they still call confirm.
 */
export async function confirmBvnMatch(userId: string) {
  const profile = await prisma.kycProfile.findUniqueOrThrow({ where: { userId } });
  if (!profile.bvn) throw new AppError(400, "BVN not submitted", "BVN_MISSING");

  if (profile.status === "APPROVED") {
    return getKycStatus(userId);
  }

  if (profile.status === "PENDING_REVIEW" || profile.bvnProviderStatus === "PENDING" || profile.bvnProviderStatus === "RETRY") {
    throw new AppError(
      409,
      "BVN is still being verified. We'll notify you when it's done.",
      "BVN_PENDING_REVIEW",
    );
  }

  if (profile.status === "REJECTED") {
    throw new AppError(
      400,
      profile.rejectionReason ?? "BVN verification failed",
      "BVN_FAILED",
    );
  }

  // IN_PROGRESS leftover — promote if we already have a matched name
  if (profile.status === "IN_PROGRESS" && profile.bvnName && (profile.bvnMatchScore ?? 0) >= 0.5) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { kycTier: "TIER_1" } }),
      prisma.kycProfile.update({
        where: { userId },
        data: { status: "APPROVED", bvnProviderStatus: profile.bvnProviderStatus ?? "SUCCESS" },
      }),
    ]);
    await writeAudit({
      actorUserId: userId,
      action: "kyc.tier1_approved",
      entityType: "User",
      entityId: userId,
    });
    return getKycStatus(userId);
  }

  throw new AppError(400, "BVN verification failed", "BVN_FAILED");
}

/**
 * Queue Tier 2 (NIN + profile) for async Prembly verification.
 * Selfie / address docs are stored for admin viewing — Tier 2 auto-approves on NIN + name match.
 */
export async function submitTier2(input: {
  userId: string;
  nin: string;
  occupation: string;
  employmentStatus: string;
  sourceOfFunds: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressLga: string;
  selfieUri: string;
  addressDocUri: string;
}) {
  if (!/^\d{11}$/.test(input.nin)) throw new AppError(400, "NIN must be 11 digits", "NIN_INVALID");
  if (!input.selfieUri.trim()) {
    throw new AppError(400, "Selfie is required for Tier 2", "SELFIE_REQUIRED");
  }
  if (!input.addressDocUri.trim()) {
    throw new AppError(400, "Proof of address is required for Tier 2", "ADDRESS_DOC_REQUIRED");
  }
  // Temporarily accept legacy local device URIs (file://, content://, etc.) so older
  // app builds can still submit Tier 2. New builds upload via POST /v1/kyc/documents.

  await prisma.$transaction([
    prisma.user.update({
      where: { id: input.userId },
      data: {
        occupation: input.occupation,
        employmentStatus: input.employmentStatus,
        sourceOfFunds: input.sourceOfFunds,
        addressStreet: input.addressStreet,
        addressCity: input.addressCity,
        addressState: input.addressState,
        addressLga: input.addressLga,
      },
    }),
    prisma.kycProfile.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        nin: input.nin,
        ninName: null,
        ninMatchScore: null,
        livenessPassed: false,
        addressDocUrl: input.addressDocUri.trim(),
        selfieUrl: input.selfieUri.trim(),
        status: "PENDING_REVIEW",
        provider: "prembly",
        ninProviderStatus: "PENDING",
        providerAttempts: 0,
        providerLastError: null,
        rejectionReason: null,
      },
      update: {
        nin: input.nin,
        ninName: null,
        ninMatchScore: null,
        livenessPassed: false,
        addressDocUrl: input.addressDocUri.trim(),
        selfieUrl: input.selfieUri.trim(),
        status: "PENDING_REVIEW",
        provider: "prembly",
        ninProviderStatus: "PENDING",
        providerAttempts: 0,
        providerLastError: null,
        providerReference: null,
        providerCheckedAt: null,
        rejectionReason: null,
        reviewedAt: null,
        reviewedByAdminId: null,
      },
    }),
  ]);

  await writeAudit({
    actorUserId: input.userId,
    action: "kyc.nin_queued",
    entityType: "User",
    entityId: input.userId,
    after: { provider: "prembly" },
  });

  return getKycStatus(input.userId);
}

export async function adminReviewKyc(input: {
  userId: string;
  adminId: string;
  approve: boolean;
  reason?: string;
}) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  const profile = await prisma.kycProfile.findUniqueOrThrow({ where: { userId: input.userId } });

  if (input.approve) {
    const nextTier = profile.nin ? "TIER_2" : "TIER_1";
    await prisma.$transaction([
      prisma.user.update({ where: { id: input.userId }, data: { kycTier: nextTier } }),
      prisma.kycProfile.update({
        where: { userId: input.userId },
        data: {
          status: "APPROVED",
          reviewedByAdminId: input.adminId,
          reviewedAt: new Date(),
          rejectionReason: null,
          ...(nextTier === "TIER_2"
            ? {
                ninProviderStatus: "SUCCESS",
                livenessPassed: Boolean(profile.selfieUrl),
              }
            : { bvnProviderStatus: "SUCCESS" }),
          ...(nextTier === "TIER_1" && !profile.bvnName
            ? {
                bvnName: `${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`.trim(),
              }
            : {}),
        },
      }),
    ]);
  } else {
    await prisma.kycProfile.update({
      where: { userId: input.userId },
      data: {
        status: "REJECTED",
        rejectionReason: input.reason ?? "Additional information required",
        reviewedByAdminId: input.adminId,
        reviewedAt: new Date(),
        ...(profile.nin
          ? { ninProviderStatus: "FAILED" }
          : { bvnProviderStatus: "FAILED" }),
      },
    });
  }

  await writeAudit({
    actorAdminId: input.adminId,
    action: input.approve
      ? profile.nin
        ? "kyc.tier2_approved"
        : "kyc.tier1_approved"
      : profile.nin
        ? "kyc.tier2_rejected"
        : "kyc.tier1_rejected",
    entityType: "User",
    entityId: user.id,
    after: { reason: input.reason },
  });

  // Notify customer (branded email, no deep-link CTA)
  const title = input.approve
    ? profile.nin
      ? "Tier 2 approved"
      : "Tier 1 approved"
    : "Verification update";
  const body = input.approve
    ? profile.nin
      ? "Your Tier 2 verification was approved. You can now withdraw to your bank account."
      : "Your identity check was approved. You can fund your wallet and invest."
    : input.reason ?? "Your verification was not approved. Please try again or contact support.";

  await prisma.notification.create({
    data: {
      userId: input.userId,
      title,
      body,
      href: "/settings/verification",
    },
  });

  if (user.email) {
    await sendBrandedNoticeEmail({
      to: user.email,
      firstName: user.firstName,
      subject: title,
      title,
      body,
    }).catch(() => undefined);
  }

  return getKycStatus(input.userId);
}
