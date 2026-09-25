import { nanoid } from "nanoid";
import type { Gift, User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { koboToNaira } from "../lib/crypto.js";
import { ensureSystemAccount, postJournal } from "./ledger.js";
import { writeAudit } from "./audit.js";

/** Normalize phone digits for gift matching (NG-friendly). */
export function giftPhoneVariants(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return [raw.trim()].filter(Boolean);
  const set = new Set<string>([digits, raw.trim()]);
  if (digits.startsWith("234") && digits.length >= 13) {
    set.add(`0${digits.slice(3)}`);
    set.add(digits.slice(3));
  } else if (digits.startsWith("0") && digits.length === 11) {
    set.add(`234${digits.slice(1)}`);
    set.add(digits.slice(1));
  } else if (digits.length === 10) {
    set.add(`0${digits}`);
    set.add(`234${digits}`);
  }
  return [...set];
}

export function giftClaimLink(claimCode: string) {
  const base = env.WEB_APP_URL.replace(/\/$/, "");
  return `${base}/gifts/claim/${encodeURIComponent(claimCode)}`;
}

function rateForTenorDays(
  days: number,
  bands: { code: string; minDays: number; maxDays: number | null; rateBps: number }[],
) {
  const band = bands.find((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  if (!band) {
    const fallback = bands.find((b) => b.code !== "CALL") ?? bands[0];
    if (!fallback) throw new AppError(400, "No rate band for tenor", "RATE_BAND_MISSING");
    return fallback;
  }
  return band;
}

export type ClaimedGiftResult = {
  giftId: string;
  claimCode: string;
  placementId: string;
  amount: number;
  tenorDays: number;
  ratePct: number;
  maturityDate: string;
};

/**
 * Claim a pending gift for an authenticated user: moves suspense funds into a
 * fixed placement in their portfolio (investment "already subscribed").
 */
export async function claimGiftForUser(
  userId: string,
  claimCode: string,
): Promise<ClaimedGiftResult> {
  const code = claimCode.trim().toUpperCase();
  const gift = await prisma.gift.findUnique({
    where: { claimCode: code },
    include: { sender: true },
  });
  if (!gift) throw new AppError(404, "Gift not found", "NOT_FOUND");
  if (gift.status === "CLAIMED") {
    if (gift.recipientId === userId && gift.placementId) {
      const p = await prisma.placement.findUnique({ where: { id: gift.placementId } });
      return {
        giftId: gift.id,
        claimCode: gift.claimCode,
        placementId: gift.placementId,
        amount: koboToNaira(gift.amountKobo),
        tenorDays: gift.tenorDays,
        ratePct: p ? p.rateBps / 100 : 0,
        maturityDate: p?.maturityDate?.toISOString().slice(0, 10) ?? "—",
      };
    }
    throw new AppError(409, "This gift was already claimed", "ALREADY_CLAIMED");
  }
  if (gift.status !== "PENDING") {
    throw new AppError(400, "This gift cannot be claimed", "GIFT_UNAVAILABLE");
  }
  if (gift.expiresAt && gift.expiresAt.getTime() < Date.now()) {
    await prisma.gift.update({
      where: { id: gift.id },
      data: { status: "EXPIRED" },
    });
    throw new AppError(410, "This gift has expired", "GIFT_EXPIRED");
  }
  if (gift.senderId === userId) {
    throw new AppError(400, "You cannot claim your own gift", "SELF_CLAIM");
  }

  const tenorDays = gift.tenorDays > 0 ? gift.tenorDays : 90;
  const bands = await prisma.rateBand.findMany();
  const band = rateForTenorDays(tenorDays, bands);
  const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");

  const placementTag = `gift_${nanoid(10)}`;
  const placementAccount = await prisma.ledgerAccount.create({
    data: {
      userId,
      type: "USER_PLACEMENT",
      tag: placementTag,
      currency: "NGN",
      balanceKobo: 0n,
    },
  });

  await postJournal({
    kind: "PLACEMENT",
    idempotencyKey: `gift-claim-${gift.claimCode}`,
    description: `Gift investment claimed (${gift.claimCode})`,
    metadata: { giftId: gift.id, claimCode: gift.claimCode },
    lines: [
      { accountId: suspense.id, amountKobo: -gift.amountKobo },
      { accountId: placementAccount.id, amountKobo: gift.amountKobo },
    ],
  });

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + tenorDays);
  const planName =
    gift.recipientName?.trim()
      ? `Gift for ${gift.recipientName.trim()}`
      : "Gift investment";

  const placement = await prisma.placement.create({
    data: {
      userId,
      kind: "FIXED",
      name: planName,
      principalKobo: gift.amountKobo,
      rateBps: band.rateBps,
      tenorDays,
      maturityDate,
      maturityInstruction: "WALLET",
      isGift: true,
      ledgerAccountId: placementAccount.id,
    },
  });

  await prisma.gift.update({
    where: { id: gift.id },
    data: {
      status: "CLAIMED",
      recipientId: userId,
      placementId: placement.id,
      claimedAt: new Date(),
    },
  });

  await writeAudit({
    actorUserId: userId,
    action: "gift.claimed",
    entityType: "Gift",
    entityId: gift.id,
    after: { placementId: placement.id, claimCode: gift.claimCode },
  });

  const { notifyCustomer } = await import("./notify.js");
  await notifyCustomer({
    userId,
    title: "Gift claimed",
    body: `₦${koboToNaira(gift.amountKobo).toLocaleString()} gift investment is now in your portfolio.`,
    href: "/portfolio",
    emailKind: "investment",
    amountNaira: koboToNaira(gift.amountKobo),
    emailDetail: planName,
  }).catch(() => undefined);

  if (gift.senderId) {
    await notifyCustomer({
      userId: gift.senderId,
      title: "Your gift was claimed",
      body: `${gift.recipientName || "Your recipient"} claimed the ₦${koboToNaira(gift.amountKobo).toLocaleString()} gift.`,
      href: "/gifts",
      emailKind: "investment",
      amountNaira: koboToNaira(gift.amountKobo),
    }).catch(() => undefined);
  }

  return {
    giftId: gift.id,
    claimCode: gift.claimCode,
    placementId: placement.id,
    amount: koboToNaira(gift.amountKobo),
    tenorDays,
    ratePct: band.rateBps / 100,
    maturityDate: maturityDate.toISOString().slice(0, 10),
  };
}

/** Auto-claim all pending gifts whose recipient phone matches the user. */
export async function claimPendingGiftsForUser(userId: string): Promise<ClaimedGiftResult[]> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.phone) return [];
  const variants = giftPhoneVariants(user.phone);
  if (variants.length === 0) return [];

  const pending = await prisma.gift.findMany({
    where: {
      status: "PENDING",
      recipientPhone: { in: variants },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    take: 20,
  });

  const claimed: ClaimedGiftResult[] = [];
  for (const g of pending) {
    try {
      claimed.push(await claimGiftForUser(userId, g.claimCode));
    } catch {
      /* skip conflicts */
    }
  }
  return claimed;
}

export function publicGiftPreview(gift: Gift & { sender: Pick<User, "firstName"> }) {
  return {
    claimCode: gift.claimCode,
    amount: koboToNaira(gift.amountKobo),
    message: gift.message ?? "",
    recipientName: gift.recipientName ?? null,
    senderFirstName: gift.sender.firstName,
    tenorDays: gift.tenorDays,
    status:
      gift.status === "CLAIMED"
        ? ("Claimed" as const)
        : gift.status === "EXPIRED" || gift.status === "CANCELLED"
          ? ("Expired" as const)
          : gift.expiresAt && gift.expiresAt.getTime() < Date.now()
            ? ("Expired" as const)
            : ("Pending" as const),
    expiresDate: gift.expiresAt?.toISOString().slice(0, 10) ?? null,
    claimLink: giftClaimLink(gift.claimCode),
  };
}
