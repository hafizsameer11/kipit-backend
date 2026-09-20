import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "./audit.js";

/** Demo BVN that auto-matches (same as web prototype). */
export const DEMO_BVN = "22123456789";

function normalizeName(s: string) {
  return s
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function fuzzyScore(a: string, b: string) {
  const aa = new Set(normalizeName(a).split(" "));
  const bb = new Set(normalizeName(b).split(" "));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return hit / Math.max(aa.size, bb.size);
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
      livenessPassed: profile.livenessPassed,
      hasAddressDoc: Boolean(profile.addressDocUrl),
      occupation: user.occupation,
      employmentStatus: user.employmentStatus,
      sourceOfFunds: user.sourceOfFunds,
      rejectionReason: profile.rejectionReason,
    },
  };
}

export async function submitBvn(userId: string, bvn: string) {
  if (!/^\d{11}$/.test(bvn)) throw new AppError(400, "BVN must be 11 digits", "BVN_INVALID");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const typedName = `${user.firstName} ${user.middleName ?? ""} ${user.surname}`;

  // Instant sandbox match only for the demo BVN. Any other 11-digit BVN goes to compliance review.
  if (bvn !== DEMO_BVN) {
    const profile = await prisma.kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        bvn,
        bvnName: null,
        status: "PENDING_REVIEW",
        rejectionReason: null,
      },
      update: {
        bvn,
        bvnName: null,
        status: "PENDING_REVIEW",
        rejectionReason: null,
      },
    });

    await writeAudit({
      actorUserId: userId,
      action: "kyc.bvn_pending_review",
      entityType: "KycProfile",
      entityId: profile.id,
    });

    return {
      match: "pending" as const,
      score: 0,
      bvnName: "Pending verification",
      profileId: profile.id,
      pending: true,
    };
  }

  const bvnName = `${user.surname.toUpperCase()} ${user.firstName.toUpperCase()} ${(user.middleName ?? "").toUpperCase()}`.trim();
  const score = fuzzyScore(typedName, bvnName);

  const profile = await prisma.kycProfile.upsert({
    where: { userId },
    create: {
      userId,
      bvn,
      bvnName,
      bvnMatchScore: score,
      status: score >= 0.5 ? "IN_PROGRESS" : "PENDING_REVIEW",
    },
    update: {
      bvn,
      bvnName,
      bvnMatchScore: score,
      status: score >= 0.5 ? "IN_PROGRESS" : "PENDING_REVIEW",
      rejectionReason: null,
    },
  });

  return {
    match: score >= 0.85 ? ("strong" as const) : score >= 0.5 ? ("partial" as const) : ("mismatch" as const),
    score,
    bvnName,
    profileId: profile.id,
    pending: score < 0.5,
  };
}

export async function confirmBvnMatch(userId: string) {
  const profile = await prisma.kycProfile.findUniqueOrThrow({ where: { userId } });
  if (!profile.bvn) throw new AppError(400, "BVN not submitted", "BVN_MISSING");

  // Non-demo BVNs stay in PENDING_REVIEW until an admin approves.
  if (profile.bvn !== DEMO_BVN || profile.status === "PENDING_REVIEW") {
    if (profile.status === "PENDING_REVIEW") {
      throw new AppError(
        409,
        "BVN is awaiting compliance review",
        "BVN_PENDING_REVIEW",
      );
    }
    throw new AppError(400, "BVN verification failed", "BVN_FAILED");
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { kycTier: "TIER_1" } }),
    prisma.kycProfile.update({
      where: { userId },
      data: { status: "APPROVED" },
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
}) {
  if (!/^\d{11}$/.test(input.nin)) throw new AppError(400, "NIN must be 11 digits", "NIN_INVALID");

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
        livenessPassed: true,
        addressDocUrl: "sandbox://address-doc",
        selfieUrl: "sandbox://selfie",
        status: "PENDING_REVIEW",
      },
      update: {
        nin: input.nin,
        livenessPassed: true,
        addressDocUrl: "sandbox://address-doc",
        selfieUrl: "sandbox://selfie",
        status: "PENDING_REVIEW",
      },
    }),
  ]);

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
    // BVN-only pending → Tier 1; NIN / full Tier 2 pack → Tier 2
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

  return getKycStatus(input.userId);
}
