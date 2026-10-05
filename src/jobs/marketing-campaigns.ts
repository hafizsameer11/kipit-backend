/**
 * Marketing campaign delivery — push and/or email to audience segments.
 * Triggered by Send now, create-as-scheduled when due, or the worker tick.
 */
import { prisma } from "../lib/prisma.js";
import { getConfigJson, setConfigJson, type StoredCampaign } from "../services/admin-ops-store.js";
import { createUserNotification } from "../services/notify.js";
import { brandWrap, sendEmail } from "../services/email.js";

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
  const select = {
    id: true,
    email: true,
    firstName: true,
    notificationPrefs: { select: { emailMarketing: true, pushProducts: true } },
  } as const;

  switch (audience) {
    case "seg-tier0":
      return prisma.user.findMany({
        where: { ...base, kycTier: "TIER_0" },
        select,
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
        select,
      });
    case "seg-idle":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { none: { status: "ACTIVE" } },
        },
        select,
      });
    case "seg-active":
      return prisma.user.findMany({
        where: {
          ...base,
          placements: { some: { status: "ACTIVE" } },
        },
        select,
      });
    case "seg-all":
    default:
      return prisma.user.findMany({
        where: base,
        select,
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

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendCampaignEmail(input: {
  to: string;
  firstName: string;
  subject: string;
  body: string;
  cta?: string | null;
  deepLink?: string | null;
}) {
  const name = input.firstName.trim() || "there";
  const subject = input.subject.slice(0, 120);
  const bodyText = input.body.trim();
  const cta = (input.cta || "").trim();
  const link = (input.deepLink || "").trim();
  const text = [
    `Hi ${name},`,
    "",
    bodyText,
    cta && link ? `\n${cta}: ${link}` : cta || link ? `\n${cta || link}` : "",
    "",
    "— Kipit Asset Management Limited",
  ]
    .filter(Boolean)
    .join("\n");

  const ctaHtml =
    cta || link
      ? `<p style="margin:20px 0 0">
          ${
            link
              ? `<a href="${escapeHtml(link)}" style="display:inline-block;background:#0b1d3a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">${escapeHtml(cta || "Open Kipit")}</a>`
              : `<strong>${escapeHtml(cta)}</strong>`
          }
        </p>`
      : "";

  const html = brandWrap(
    subject,
    `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
     <p style="margin:0;white-space:pre-line">${escapeHtml(bodyText)}</p>
     ${ctaHtml}`,
  );

  return sendEmail({ to: input.to, subject, text, html });
}

export async function sendMarketingCampaign(campaignId: string): Promise<{
  id: string;
  status: string;
  channel: string;
  recipients: number;
  delivered: number;
  emailed?: number;
  skipped?: number;
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
  const pushBody = (campaign.body || "").slice(0, 180);
  const emailBody = (campaign.body || "").trim() || title;
  const channel = (campaign.channel || "push").toLowerCase();
  const isEmail = channel === "email" || channel.includes("email");
  const isPush = channel === "push" || channel.includes("push") || channel === "both";

  let delivered = 0;
  let emailed = 0;
  let skipped = 0;
  const queue = [...recipients];

  await mapPool(queue, 8, async (user) => {
    try {
      if (isEmail) {
        const to = (user.email || "").trim();
        if (!to) {
          skipped += 1;
          return;
        }
        // Admin-initiated campaigns email the selected audience.
        // Automatic digests still honour emailDigest / emailMarketing in their own jobs.
        await sendCampaignEmail({
          to,
          firstName: user.firstName || "",
          subject: title,
          body: emailBody,
          cta: campaign.cta,
          deepLink: campaign.deepLink,
        });
        // Mirror in-app (no push) so the message appears in Notifications too.
        await createUserNotification({
          userId: user.id,
          title,
          body: pushBody,
          href,
          pushKind: "product",
          skipPush: true,
        }).catch(() => undefined);
        emailed += 1;
        delivered += 1;
        return;
      }

      // Push (+ in-app). Honour product push opt-out when set.
      if (user.notificationPrefs?.pushProducts === false) {
        skipped += 1;
        return;
      }
      await createUserNotification({
        userId: user.id,
        title,
        body: pushBody,
        href,
        pushKind: "product",
        skipPush: !isPush,
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
    emailed,
    skipped,
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
