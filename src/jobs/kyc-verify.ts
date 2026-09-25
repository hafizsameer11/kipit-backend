import { prisma } from "../lib/prisma.js";
import { sendBrandedNoticeEmail } from "../services/email.js";
import { writeAudit } from "../services/audit.js";
import { verifyBvnWithPrembly, verifyNinWithPrembly } from "../services/prembly.js";
import { fuzzyScore, formatPremblyName } from "../services/kyc.js";

const MAX_ATTEMPTS = 8;
const BATCH = 25;

async function notifyUser(input: {
  userId: string;
  email: string | null | undefined;
  firstName?: string | null;
  title: string;
  body: string;
  href?: string;
}) {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body,
      href: input.href,
    },
  });
  if (input.email) {
    await sendBrandedNoticeEmail({
      to: input.email,
      firstName: input.firstName,
      subject: input.title,
      title: input.title,
      body: input.body,
    }).catch(() => undefined);
  }
}

async function processBvnCase(profileId: string) {
  const profile = await prisma.kycProfile.findUnique({
    where: { id: profileId },
    include: { user: true },
  });
  if (!profile?.bvn || profile.status !== "PENDING_REVIEW") return "skipped";
  if (profile.bvnProviderStatus === "SUCCESS") return "skipped";
  if (profile.nin && !profile.bvnName) {
    // Tier-2 pack waiting; still verify BVN first if needed — fall through
  }

  const typedName = `${profile.user.firstName} ${profile.user.middleName ?? ""} ${profile.user.surname}`;
  const result = await verifyBvnWithPrembly(profile.bvn, typedName);
  const attempts = profile.providerAttempts + 1;

  if (!result.ok) {
    if (result.retryable && attempts < MAX_ATTEMPTS) {
      await prisma.kycProfile.update({
        where: { id: profile.id },
        data: {
          provider: "prembly",
          bvnProviderStatus: "RETRY",
          providerAttempts: attempts,
          providerLastError: result.message,
          providerReference: result.reference,
          providerCheckedAt: new Date(),
        },
      });
      return "retry";
    }

    const reason = result.message || "BVN verification failed";
    await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: "REJECTED",
        bvnProviderStatus: "FAILED",
        providerAttempts: attempts,
        providerLastError: reason,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: reason,
        reviewedAt: new Date(),
      },
    });

    await notifyUser({
      userId: profile.userId,
      email: profile.user.email,
      firstName: profile.user.firstName,
      title: "BVN verification failed",
      body: reason,
      href: "/settings/verification",
    });

    await writeAudit({
      actorUserId: profile.userId,
      action: "kyc.bvn_rejected_provider",
      entityType: "KycProfile",
      entityId: profile.id,
      after: { responseCode: result.responseCode, reason },
    });
    return "rejected";
  }

  const bvnName = formatPremblyName(result.person);
  const score = fuzzyScore(typedName, bvnName);

  if (score < 0.5) {
    const reason =
      "The name on this BVN does not match your Kipit profile. Update your bank record or contact support.";
    await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: "REJECTED",
        bvnName,
        bvnMatchScore: score,
        bvnProviderStatus: "FAILED",
        providerAttempts: attempts,
        providerLastError: reason,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: reason,
        reviewedAt: new Date(),
      },
    });

    await notifyUser({
      userId: profile.userId,
      email: profile.user.email,
      firstName: profile.user.firstName,
      title: "BVN verification failed",
      body: reason,
      href: "/settings/verification",
    });

    await writeAudit({
      actorUserId: profile.userId,
      action: "kyc.bvn_rejected_mismatch",
      entityType: "KycProfile",
      entityId: profile.id,
      after: { score, bvnName },
    });
    return "rejected";
  }

  // Strong / partial match → auto Tier 1 (keep PENDING_REVIEW if NIN still queued)
  const ninStillPending =
    Boolean(profile.nin) &&
    profile.ninProviderStatus !== "SUCCESS" &&
    profile.ninProviderStatus !== "FAILED";

  await prisma.$transaction([
    prisma.user.update({
      where: { id: profile.userId },
      data: { kycTier: "TIER_1" },
    }),
    prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: ninStillPending ? "PENDING_REVIEW" : "APPROVED",
        bvnName,
        bvnMatchScore: score,
        bvnProviderStatus: "SUCCESS",
        providerAttempts: attempts,
        providerLastError: null,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: null,
        reviewedAt: ninStillPending ? null : new Date(),
      },
    }),
  ]);

  await notifyUser({
    userId: profile.userId,
    email: profile.user.email,
    firstName: profile.user.firstName,
    title: "Tier 1 approved",
    body: ninStillPending
      ? "Your BVN was verified. We're still confirming your NIN for Tier 2."
      : "Your BVN was verified successfully. You can fund your wallet and invest.",
    href: ninStillPending ? "/settings/verification" : "/wallet/add-money",
  });

  await writeAudit({
    actorUserId: profile.userId,
    action: "kyc.tier1_approved_provider",
    entityType: "User",
    entityId: profile.userId,
    after: { score, provider: "prembly", reference: result.reference },
  });
  return "approved";
}

async function processNinCase(profileId: string) {
  const profile = await prisma.kycProfile.findUnique({
    where: { id: profileId },
    include: { user: true },
  });
  if (!profile?.nin || profile.status !== "PENDING_REVIEW") return "skipped";
  if (profile.ninProviderStatus === "SUCCESS") return "skipped";
  // Require BVN path finished (or already Tier 1+) before promoting to Tier 2
  if (profile.user.kycTier === "TIER_0" && profile.bvn && profile.bvnProviderStatus !== "SUCCESS") {
    return "skipped";
  }

  const typedName = `${profile.user.firstName} ${profile.user.middleName ?? ""} ${profile.user.surname}`;
  const result = await verifyNinWithPrembly(profile.nin, typedName);
  const attempts = profile.providerAttempts + 1;

  if (!result.ok) {
    if (result.retryable && attempts < MAX_ATTEMPTS) {
      await prisma.kycProfile.update({
        where: { id: profile.id },
        data: {
          provider: "prembly",
          ninProviderStatus: "RETRY",
          providerAttempts: attempts,
          providerLastError: result.message,
          providerReference: result.reference,
          providerCheckedAt: new Date(),
        },
      });
      return "retry";
    }

    const reason = result.message || "NIN verification failed";
    await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: "REJECTED",
        ninProviderStatus: "FAILED",
        providerAttempts: attempts,
        providerLastError: reason,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: reason,
        reviewedAt: new Date(),
      },
    });

    await notifyUser({
      userId: profile.userId,
      email: profile.user.email,
      firstName: profile.user.firstName,
      title: "NIN verification failed",
      body: reason,
      href: "/settings/verification",
    });

    await writeAudit({
      actorUserId: profile.userId,
      action: "kyc.nin_rejected_provider",
      entityType: "KycProfile",
      entityId: profile.id,
      after: { responseCode: result.responseCode, reason },
    });
    return "rejected";
  }

  const ninName = formatPremblyName(result.person);
  const score = fuzzyScore(typedName, ninName);

  if (score < 0.5) {
    const reason =
      "The name on this NIN does not match your Kipit profile. Update your NIMC record or contact support.";
    await prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: "REJECTED",
        ninName,
        ninMatchScore: score,
        ninProviderStatus: "FAILED",
        providerAttempts: attempts,
        providerLastError: reason,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: reason,
        reviewedAt: new Date(),
      },
    });

    await notifyUser({
      userId: profile.userId,
      email: profile.user.email,
      firstName: profile.user.firstName,
      title: "NIN verification failed",
      body: reason,
      href: "/settings/verification",
    });

    await writeAudit({
      actorUserId: profile.userId,
      action: "kyc.nin_rejected_mismatch",
      entityType: "KycProfile",
      entityId: profile.id,
      after: { score, ninName },
    });
    return "rejected";
  }

  // NIN + name match → auto-approve Tier 2. Selfie / address stay on the profile for admin viewing only.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: profile.userId },
      data: { kycTier: "TIER_2" },
    }),
    prisma.kycProfile.update({
      where: { id: profile.id },
      data: {
        provider: "prembly",
        status: "APPROVED",
        ninName,
        ninMatchScore: score,
        ninProviderStatus: "SUCCESS",
        providerAttempts: attempts,
        providerLastError: null,
        providerReference: result.reference,
        providerCheckedAt: new Date(),
        rejectionReason: null,
        reviewedAt: new Date(),
      },
    }),
  ]);

  await notifyUser({
    userId: profile.userId,
    email: profile.user.email,
    firstName: profile.user.firstName,
    title: "Tier 2 approved",
    body: "Your Tier 2 verification was approved. You can now withdraw to your bank account.",
    href: "/withdraw",
  });

  await writeAudit({
    actorUserId: profile.userId,
    action: "kyc.tier2_approved_provider",
    entityType: "User",
    entityId: profile.userId,
    after: { score, provider: "prembly", reference: result.reference },
  });
  return "approved";
}

/**
 * Async Prembly KYC worker: pick pending BVN / NIN cases, verify, approve or reject + notify.
 */
export async function runKycVerificationJob() {
  const run = await prisma.jobRun.create({
    data: { jobName: "kyc-verify", status: "running" },
  });

  const counts = { approved: 0, rejected: 0, retry: 0, skipped: 0, errors: 0 };

  try {
    const bvnPending = await prisma.kycProfile.findMany({
      where: {
        status: "PENDING_REVIEW",
        bvn: { not: null },
        OR: [
          { bvnProviderStatus: null },
          { bvnProviderStatus: "PENDING" },
          { bvnProviderStatus: "RETRY" },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: BATCH,
      select: { id: true },
    });

    for (const row of bvnPending) {
      try {
        const outcome = await processBvnCase(row.id);
        if (outcome === "approved") counts.approved++;
        else if (outcome === "rejected") counts.rejected++;
        else if (outcome === "retry") counts.retry++;
        else counts.skipped++;
      } catch (err) {
        counts.errors++;
        console.error("[kyc-verify] bvn case failed", row.id, err);
        await prisma.kycProfile
          .update({
            where: { id: row.id },
            data: {
              bvnProviderStatus: "RETRY",
              providerAttempts: { increment: 1 },
              providerLastError: err instanceof Error ? err.message : "BVN job error",
              providerCheckedAt: new Date(),
            },
          })
          .catch(() => undefined);
      }
    }

    const ninPending = await prisma.kycProfile.findMany({
      where: {
        status: "PENDING_REVIEW",
        nin: { not: null },
        OR: [
          { ninProviderStatus: null },
          { ninProviderStatus: "PENDING" },
          { ninProviderStatus: "RETRY" },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: BATCH,
      select: { id: true },
    });

    for (const row of ninPending) {
      try {
        const outcome = await processNinCase(row.id);
        if (outcome === "approved") counts.approved++;
        else if (outcome === "rejected") counts.rejected++;
        else if (outcome === "retry") counts.retry++;
        else counts.skipped++;
      } catch (err) {
        counts.errors++;
        console.error("[kyc-verify] nin case failed", row.id, err);
        await prisma.kycProfile
          .update({
            where: { id: row.id },
            data: {
              ninProviderStatus: "RETRY",
              providerAttempts: { increment: 1 },
              providerLastError: err instanceof Error ? err.message : "NIN job error",
              providerCheckedAt: new Date(),
            },
          })
          .catch(() => undefined);
      }
    }

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "ok",
        finishedAt: new Date(),
        detail: counts,
      },
    });

    return { runId: run.id, ...counts };
  } catch (err) {
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "error",
        finishedAt: new Date(),
        detail: { error: err instanceof Error ? err.message : String(err) },
      },
    });
    throw err;
  }
}
