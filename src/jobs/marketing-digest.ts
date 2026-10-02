/**
 * Daily portfolio digest — scheduled by kipit-worker or POST /v1/admin/marketing/digest/send-now.
 * Creates in-app notifications + Expo push for each eligible customer.
 */
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import { getConfigJson, setConfigJson } from "../services/admin-ops-store.js";
import { createUserNotification } from "../services/notify.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";

const DEFAULT_DIGEST = {
  enabled: true,
  sendTime: "07:30",
  audience: "seg-active",
  lastRun: null as string | null,
  deliveredYesterday: 0,
  openRate: 0,
};

type DigestAudience =
  | "seg-all"
  | "seg-active"
  | "seg-idle"
  | "seg-tier0"
  | "seg-maturing"
  | string;

function naira(value: number) {
  return `₦${Math.round(value).toLocaleString("en-NG")}`;
}

async function listDigestRecipients(audience: DigestAudience) {
  const base = { frozen: false as const };
  const now = new Date();
  const in7 = new Date(Date.now() + 7 * 86400000);

  switch (audience) {
    case "seg-tier0":
      return prisma.user.findMany({
        where: { ...base, kycTier: "TIER_0" },
        select: { id: true, firstName: true },
      });
    case "seg-maturing":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: {
            some: {
              status: "ACTIVE",
              maturityDate: { gte: now, lte: in7 },
            },
          },
        },
        select: { id: true, firstName: true },
      });
    case "seg-idle":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { none: { status: "ACTIVE" } },
        },
        select: { id: true, firstName: true },
      });
    case "seg-all":
      return prisma.user.findMany({
        where: base,
        select: { id: true, firstName: true },
      });
    case "seg-active":
    default:
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { some: { status: "ACTIVE" } },
        },
        select: { id: true, firstName: true },
      });
  }
}

async function portfolioSummary(userId: string) {
  const [wallet, call, placements] = await Promise.all([
    ensureUserWallet(userId),
    ensureUserCall(userId),
    prisma.placement.findMany({
      where: { userId, status: "ACTIVE" },
      select: { principalKobo: true, name: true, maturityDate: true },
      orderBy: { maturityDate: "asc" },
      take: 3,
    }),
  ]);
  const placed = placements.reduce((s, p) => s + p.principalKobo, 0n);
  const total = wallet.balanceKobo + call.balanceKobo + placed;
  const next = placements.find((p) => p.maturityDate) ?? null;
  return {
    totalNaira: koboToNaira(total),
    walletNaira: koboToNaira(wallet.balanceKobo),
    callNaira: koboToNaira(call.balanceKobo),
    placedNaira: koboToNaira(placed),
    nextMaturity: next?.maturityDate
      ? next.maturityDate.toISOString().slice(0, 10)
      : null,
    nextName: next?.name ?? null,
  };
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

export async function runMarketingDigestJob(input?: { manual?: boolean; adminId?: string }) {
  const digest = await getConfigJson("marketing.digest", DEFAULT_DIGEST);
  const audience = String(digest.audience || "seg-active");
  const recipients = await listDigestRecipients(audience);

  let delivered = 0;
  let skippedPrefs = 0;
  let failed = 0;

  await mapPool(recipients, 8, async (user) => {
    try {
      const prefs = await prisma.notificationPref.findUnique({ where: { userId: user.id } });
      // Portfolio digest opt-out (settings → emailDigest) applies to this campaign.
      if (prefs && prefs.emailDigest === false) {
        skippedPrefs += 1;
        return;
      }

      const summary = await portfolioSummary(user.id);
      const name = user.firstName?.trim() || "there";
      const maturityBit = summary.nextMaturity
        ? ` Next maturity: ${summary.nextName ?? "plan"} on ${summary.nextMaturity}.`
        : "";
      const body = `Hi ${name}, your Kipit total is ${naira(summary.totalNaira)} (wallet ${naira(summary.walletNaira)} · call ${naira(summary.callNaira)} · invested ${naira(summary.placedNaira)}).${maturityBit}`;

      await createUserNotification({
        userId: user.id,
        title: "Your daily Kipit digest",
        body,
        href: "/portfolio",
        pushKind: "general",
      });
      delivered += 1;
    } catch (err) {
      failed += 1;
      console.warn("[digest] notify failed", user.id, err);
    }
  });

  const sentAt = new Date();
  const nextDigest = {
    ...digest,
    lastRun: sentAt.toISOString(),
    deliveredYesterday: delivered,
  };
  await setConfigJson("marketing.digest", nextDigest, input?.adminId);

  const job = await prisma.jobRun.create({
    data: {
      jobName: "marketing.digest",
      status: failed && !delivered ? "FAILED" : "SUCCESS",
      detail: {
        manual: Boolean(input?.manual),
        requestedBy: input?.adminId ?? null,
        audience,
        candidateCount: recipients.length,
        recipientCount: delivered,
        skippedPrefs,
        failed,
        push: true,
        inApp: true,
      },
      finishedAt: sentAt,
    },
  });

  return {
    jobId: job.id,
    recipientCount: delivered,
    candidateCount: recipients.length,
    skippedPrefs,
    failed,
    sentAt: sentAt.toISOString(),
  };
}
