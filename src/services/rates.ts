import { prisma } from "../lib/prisma.js";

/** UTC calendar day midnight for a Date. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function utcDayMs(d: Date): number {
  return utcDay(d).getTime();
}

/**
 * Revert bands whose live rate was applied before the effective date,
 * then apply any APPROVED changes whose effective date has arrived.
 */
export async function ensureRatesApplied(now = new Date()) {
  const today = utcDay(now);
  const todayMs = today.getTime();

  const repaired = await repairPrematureApplications(todayMs);
  const applied = await applyDueApprovedChanges(today);
  return { repaired, applied };
}

/** Undo RateBand updates that went live before their effectiveFrom. */
async function repairPrematureApplications(todayMs: number) {
  const bands = await prisma.rateBand.findMany({
    where: { effectiveFrom: { gt: new Date(todayMs) } },
  });
  let repaired = 0;

  for (const band of bands) {
    const premature = await prisma.rateChangeRequest.findFirst({
      where: {
        bandId: band.id,
        status: "APPROVED",
        proposedBps: band.rateBps,
        effectiveFrom: band.effectiveFrom,
      },
      orderBy: { decidedAt: "desc" },
    });
    if (!premature) continue;

    let previousBps = premature.previousBps;
    let previousFrom: Date | null = null;
    if (previousBps == null) {
      const prior = await prisma.rateChangeRequest.findFirst({
        where: {
          bandId: band.id,
          status: "APPROVED",
          id: { not: premature.id },
          OR: [
            { appliedAt: { not: null } },
            { effectiveFrom: { lt: premature.effectiveFrom } },
          ],
        },
        orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
      });
      if (prior) {
        previousBps = prior.proposedBps;
        previousFrom = prior.effectiveFrom;
      }
    } else {
      const prior = await prisma.rateChangeRequest.findFirst({
        where: {
          bandId: band.id,
          status: "APPROVED",
          id: { not: premature.id },
          proposedBps: previousBps,
        },
        orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
      });
      previousFrom = prior?.effectiveFrom ?? null;
    }

    if (previousBps == null) continue;

    await prisma.$transaction([
      prisma.rateBand.update({
        where: { id: band.id },
        data: {
          rateBps: previousBps,
          effectiveFrom: previousFrom ?? band.createdAt,
        },
      }),
      prisma.rateChangeRequest.update({
        where: { id: premature.id },
        data: { appliedAt: null },
      }),
    ]);
    repaired += 1;
  }

  return repaired;
}

/** Apply APPROVED rate changes whose effectiveFrom is today or earlier. */
async function applyDueApprovedChanges(today: Date) {
  const due = await prisma.rateChangeRequest.findMany({
    where: {
      status: "APPROVED",
      appliedAt: null,
      effectiveFrom: { lte: today },
    },
    orderBy: [{ effectiveFrom: "asc" }, { decidedAt: "asc" }, { createdAt: "asc" }],
  });

  // Latest due change per band wins.
  const latestByBand = new Map<string, (typeof due)[number]>();
  for (const row of due) {
    latestByBand.set(row.bandId, row);
  }

  let applied = 0;
  const now = new Date();

  for (const row of latestByBand.values()) {
    await prisma.$transaction([
      prisma.rateBand.update({
        where: { id: row.bandId },
        data: { rateBps: row.proposedBps, effectiveFrom: row.effectiveFrom },
      }),
      prisma.rateChangeRequest.update({
        where: { id: row.id },
        data: { appliedAt: now },
      }),
    ]);
    // Older due rows for same band: mark applied so they don't re-run.
    const older = due.filter((d) => d.bandId === row.bandId && d.id !== row.id);
    if (older.length) {
      await prisma.rateChangeRequest.updateMany({
        where: { id: { in: older.map((o) => o.id) } },
        data: { appliedAt: now },
      });
    }
    applied += 1;
  }

  // Backfill appliedAt for past approvals that already match the live band.
  const stale = await prisma.rateChangeRequest.findMany({
    where: {
      status: "APPROVED",
      appliedAt: null,
      effectiveFrom: { lte: today },
    },
    include: { band: true },
  });
  for (const row of stale) {
    if (row.band.rateBps === row.proposedBps) {
      await prisma.rateChangeRequest.update({
        where: { id: row.id },
        data: { appliedAt: row.decidedAt ?? now },
      });
    }
  }

  return applied;
}

export type AdminRateBandView = {
  previousBps: number | null;
  scheduledBps: number | null;
  scheduledFrom: string | null;
  pendingBps: number | null;
  pendingFrom: string | null;
  status: "active" | "scheduled" | "pending";
};

/** Enrich a live band with previous / scheduled / pending display fields. */
export async function rateBandAdminExtras(
  bandId: string,
  rateBps: number,
  now = new Date(),
): Promise<AdminRateBandView> {
  const today = utcDay(now);

  const pending = await prisma.rateChangeRequest.findFirst({
    where: {
      bandId,
      status: "PENDING",
    },
    orderBy: { createdAt: "desc" },
  });

  const scheduled = await prisma.rateChangeRequest.findFirst({
    where: {
      bandId,
      status: "APPROVED",
      appliedAt: null,
      effectiveFrom: { gt: today },
    },
    orderBy: { effectiveFrom: "asc" },
  });

  const lastApplied = await prisma.rateChangeRequest.findFirst({
    where: {
      bandId,
      status: "APPROVED",
      appliedAt: { not: null },
      proposedBps: rateBps,
    },
    orderBy: { appliedAt: "desc" },
  });

  let previousBps = lastApplied?.previousBps ?? null;
  if (previousBps == null) {
    const prior = await prisma.rateChangeRequest.findFirst({
      where: {
        bandId,
        status: "APPROVED",
        appliedAt: { not: null },
        proposedBps: { not: rateBps },
      },
      orderBy: { appliedAt: "desc" },
    });
    previousBps = prior?.proposedBps ?? null;
  }

  const status: AdminRateBandView["status"] = pending
    ? "pending"
    : scheduled
      ? "scheduled"
      : "active";

  return {
    previousBps: previousBps ?? rateBps,
    scheduledBps: scheduled?.proposedBps ?? null,
    scheduledFrom: scheduled?.effectiveFrom.toISOString().slice(0, 10) ?? null,
    pendingBps: pending?.proposedBps ?? null,
    pendingFrom: pending?.effectiveFrom.toISOString().slice(0, 10) ?? null,
    status,
  };
}
