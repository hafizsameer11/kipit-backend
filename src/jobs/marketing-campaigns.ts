/**
 * Marketing campaign delivery — push (+ in-app notification) to audience segments.
 * Triggered by Send now, create-as-scheduled when due, or the worker tick.
 */
import { prisma } from "../lib/prisma.js";
import { getConfigJson, setConfigJson, type StoredCampaign } from "../services/admin-ops-store.js";
import { createUserNotification } from "../services/notify.js";

const AUDIENCE_ALIASES: Record<string, string> = {
  "seg-all": "seg-all",
  "all customers": "seg-all",
  "seg-active": "seg-active",
  "active investors": "seg-active",
  "seg-idle": "seg-idle",
  "idle cash holders": "seg-idle",
  "seg-tier0": "seg-tier0",
  "unverified signups": "seg-tier0",
  "seg-maturing": "seg-maturing",
  "maturing in 7 days": "seg-maturing",
};

function normalizeAudience(raw?: string | null): string {
  const key = String(raw || "seg-all").trim().toLowerCase();
  return AUDIENCE_ALIASES[key] ?? (key.startsWith("seg-") ? key : "seg-all");
}

async function listCampaignRecipients(audienceRaw?: string | null) {
  const audience = normalizeAudience(audienceRaw);
  const base = { frozen: false as const };
  const now = new Date();
  const in7 = new Date(Date.now() + 7 * 86400000);

  switch (audience) {
    case "seg-tier0":
      return prisma.user.findMany({
        where: { ...base, kycTier: "TIER_0" },
        select: { id: true },
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
        select: { id: true },
      });
    case "seg-idle":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { none: { status: "ACTIVE" } },
        },
        select: { id: true },
      });
    case "seg-active":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { some: { status: "ACTIVE" } },
        },
        select: { id: true },
      });
    case "seg-all":
    default:
      return prisma.user.findMany({
        where: base,
        select: { id: true },
      });
  }
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (items.length) {
      const next = items.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

export async function sendMarketingCampaign(campaignId: string): Promise<{
  id: string;
  status: string;
  channel: string;
  recipients: number;
  delivered: number;
}> {
  const campaigns = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
  const idx = campaigns.findIndex((c) => c.id === campaignId);
  if (idx < 0) {
    throw Object.assign(new Error("Campaign not found"), { status: 404, code: "NOT_FOUND" });
  }
  const campaign = campaigns[idx]!;
  if (campaign.status === "sent") {
    return {
      id: campaign.id,
      status: campaign.status,
      channel: campaign.channel,
      recipients: campaign.reach ?? 0,
      delivered: campaign.delivered ?? 0,
    };
  }
  if (campaign.status === "paused" || campaign.status === "draft") {
    // Allow send-now from draft/paused by continuing.
  }

  const sending: StoredCampaign = {
    ...campaign,
    status: "sending",
    updatedAt: new Date().toISOString(),
  };
  campaigns[idx] = sending;
  await setConfigJson("admin.campaigns", campaigns);

  const recipients = await listCampaignRecipients(campaign.audienceId || campaign.audience);
  const href = campaign.deepLink?.trim() || "/invest";
  const title = (campaign.subject || campaign.name || "Kipit").slice(0, 80);
  const body = (campaign.body || "").slice(0, 180);
  const channel = (campaign.channel || "push").toLowerCase();

  let delivered = 0;
  const queue = [...recipients];

  await mapPool(queue, 8, async (user) => {
    try {
      if (channel === "email") {
        // Email channel: in-app notice for now (transactional email path needs amount/kind).
        await createUserNotification({
          userId: user.id,
          title,
          body,
          href,
          pushKind: "product",
          skipPush: true,
        });
        delivered += 1;
        return;
      }
      await createUserNotification({
        userId: user.id,
        title,
        body,
        href,
        pushKind: "product",
      });
      delivered += 1;
    } catch (err) {
      console.warn("[campaign] deliver failed", campaign.id, user.id, err);
    }
  });

  const latest = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
  const latestIdx = latest.findIndex((c) => c.id === campaignId);
  if (latestIdx >= 0) {
    const now = new Date().toISOString();
    latest[latestIdx] = {
      ...latest[latestIdx]!,
      status: "sent",
      sentAt: now,
      updatedAt: now,
      reach: recipients.length,
      delivered,
    };
    await setConfigJson("admin.campaigns", latest);
  }

  return {
    id: campaign.id,
    status: "sent",
    channel,
    recipients: recipients.length,
    delivered,
  };
}

/** Send scheduled / queued campaigns that are due. */
export async function runDueMarketingCampaignsJob(): Promise<{
  checked: number;
  sent: number;
  errors: number;
}> {
  const campaigns = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
  const now = Date.now();
  const due = campaigns.filter((c) => {
    if (c.status === "sending") return true;
    if (c.status !== "scheduled") return false;
    if (!c.scheduledAt) return true;
    const t = new Date(c.scheduledAt).getTime();
    return !Number.isNaN(t) && t <= now;
  });

  let sent = 0;
  let errors = 0;
  for (const c of due) {
    try {
      await sendMarketingCampaign(c.id);
      sent += 1;
    } catch (err) {
      errors += 1;
      console.error("[campaign] due send failed", c.id, err);
    }
  }
  return { checked: due.length, sent, errors };
}
