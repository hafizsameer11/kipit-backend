import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireKyc } from "../middleware/kyc.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira, nairaToKobo } from "../lib/crypto.js";
import { verifyTransactionPin } from "../services/auth.js";
import { debitWallet, ensureSystemAccount, interestForPeriod } from "../services/money.js";
import { writeAudit } from "../services/audit.js";
import { sendGiftInviteEmail } from "../services/email.js";
import {
  claimGiftForUser,
  claimPendingGiftsForUser,
  giftClaimLink,
  giftPhoneVariants,
  normalizeGiftEmail,
  publicGiftPreview,
} from "../services/gifts.js";
import { rejectIfMaintenance } from "../middleware/maintenance.js";
import { assertFeatureEnabled } from "../services/app-access.js";

export const giftsRouter = Router();
giftsRouter.use(rejectIfMaintenance);

function mapGiftStatus(status: string, expiresAt?: Date | null): "Pending" | "Claimed" | "Expired" {
  if (status === "CLAIMED") return "Claimed";
  if (status === "EXPIRED" || status === "CANCELLED") return "Expired";
  if (expiresAt && expiresAt.getTime() < Date.now()) return "Expired";
  return "Pending";
}

function mapGiftRow(
  g: {
    id: string;
    amountKobo: bigint;
    message: string | null;
    createdAt: Date;
    claimedAt: Date | null;
    expiresAt: Date | null;
    status: string;
    claimCode: string;
    recipientPhone: string | null;
    recipientEmail: string | null;
    recipientName: string | null;
    tenorDays: number;
    senderId: string;
    placement: {
      name: string;
      tenorDays: number | null;
      rateBps: number;
      maturityDate: Date | null;
      principalKobo: bigint;
      accruedKobo: bigint;
    } | null;
    recipient: { firstName: string; surname: string; phone: string | null; email: string | null } | null;
    sender?: { firstName: string; surname: string } | null;
  },
  viewerId: string,
) {
  const contact =
    g.recipientEmail ??
    g.recipientPhone ??
    g.recipient?.email ??
    g.recipient?.phone ??
    "—";
  return {
    id: g.id,
    recipient: g.recipient
      ? `${g.recipient.firstName} ${g.recipient.surname}`
      : g.recipientName ?? g.recipientEmail ?? g.recipientPhone ?? "Pending recipient",
    phone: contact,
    product: g.placement?.name ?? "Gift investment",
    tenor: `${g.placement?.tenorDays ?? g.tenorDays} days`,
    rate: g.placement ? `${(g.placement.rateBps / 100).toFixed(2)}%` : "—",
    amount: koboToNaira(g.amountKobo),
    message: g.message ?? "",
    sentDate: g.createdAt.toISOString().slice(0, 10),
    claimedDate: g.claimedAt?.toISOString().slice(0, 10),
    expiresDate: g.expiresAt?.toISOString().slice(0, 10),
    status: mapGiftStatus(g.status, g.expiresAt),
    maturityDate: g.placement?.maturityDate?.toISOString().slice(0, 10) ?? "—",
    expectedPayout: g.placement
      ? koboToNaira(g.placement.principalKobo + g.placement.accruedKobo)
      : koboToNaira(
          g.amountKobo + interestForPeriod(g.amountKobo, 1400, g.tenorDays || 90),
        ),
    claimCode: g.claimCode,
    claimLink: giftClaimLink(g.claimCode),
    direction: g.senderId === viewerId ? "sent" : "received",
  };
}

/** Public preview for invite / download link (non-app recipients). */
giftsRouter.get(
  "/claim/:code",
  asyncHandler(async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const gift = await prisma.gift.findUnique({
      where: { claimCode: code },
      include: { sender: { select: { firstName: true } }, placement: true },
    });
    if (!gift) throw new AppError(404, "Gift not found", "NOT_FOUND");
    const bands = await prisma.rateBand.findMany();
    const band =
      bands.find(
        (b) =>
          gift.tenorDays >= b.minDays && (b.maxDays == null || gift.tenorDays <= b.maxDays),
      ) ?? bands.find((b) => b.code !== "CALL");
    const rateBps = gift.placement?.rateBps ?? band?.rateBps ?? 1400;
    res.json({
      data: {
        ...publicGiftPreview(gift),
        expectedInterest: koboToNaira(
          interestForPeriod(gift.amountKobo, rateBps, gift.tenorDays || 90),
        ),
        ratePct: rateBps / 100,
      },
    });
  }),
);

/** Claim with code after signup / download (investment lands in portfolio). */
giftsRouter.post(
  "/claim",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ claimCode: z.string().min(4) }).parse(req.body);
    const claimed = await claimGiftForUser(req.userId!, body.claimCode);
    res.json({ data: claimed });
  }),
);

/** Claim any pending gifts matching the signed-in user's phone. */
giftsRouter.post(
  "/claim-pending",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const claimed = await claimPendingGiftsForUser(req.userId!);
    res.json({ data: { claimed: claimed.length, gifts: claimed } });
  }),
);

giftsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const rows = await prisma.gift.findMany({
      where: {
        OR: [{ senderId: req.userId! }, { recipientId: req.userId! }],
      },
      include: { placement: true, recipient: true, sender: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      data: rows.map((g) => mapGiftRow(g, req.userId!)),
    });
  }),
);

giftsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const g = await prisma.gift.findFirst({
      where: {
        id: String(req.params.id),
        OR: [{ senderId: req.userId! }, { recipientId: req.userId! }],
      },
      include: { placement: true, recipient: true, sender: true },
    });
    if (!g) throw new AppError(404, "Gift not found", "NOT_FOUND");
    res.json({ data: mapGiftRow(g, req.userId!) });
  }),
);

giftsRouter.post(
  "/",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    await assertFeatureEnabled("giftInvest", "Gift investments are temporarily unavailable.");
    const body = z
      .object({
        amount: z.number().positive(),
        recipientPhone: z.string().min(7).optional(),
        recipientEmail: z.string().email().optional(),
        recipientName: z.string().optional(),
        message: z.string().max(280).optional(),
        tenorDays: z.number().int().positive().optional(),
        pin: z.string().min(4),
      })
      .refine((d) => Boolean(d.recipientPhone?.trim() || d.recipientEmail?.trim()), {
        message: "Add a recipient phone number or email",
        path: ["recipientPhone"],
      })
      .parse(req.body);

    await verifyTransactionPin(req.userId!, body.pin);
    const amountKobo = nairaToKobo(body.amount);
    const claimCode = `GFT-${nanoid(8).toUpperCase()}`;
    const tenorDays = body.tenorDays && body.tenorDays > 0 ? body.tenorDays : 90;
    const email = normalizeGiftEmail(body.recipientEmail);
    const phoneRaw = body.recipientPhone?.trim() || "";
    const phoneDigits = phoneRaw.replace(/\D/g, "");
    const phone = phoneRaw
      ? giftPhoneVariants(phoneRaw)[0] ?? (phoneDigits.length >= 7 ? phoneDigits : null)
      : null;
    if (!email && (!phone || phone.length < 7)) {
      throw new AppError(400, "Add a valid recipient phone number or email", "RECIPIENT_INVALID");
    }

    const contactLabel = email || phone || "recipient";
    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "WITHDRAWAL",
      idempotencyKey: `gift-${claimCode}`,
      description: `Gift investment to ${contactLabel}`,
      creditAccountId: suspense.id,
      metadata: { claimCode, gift: true, tenorDays, recipientEmail: email, recipientPhone: phone },
    });

    const gift = await prisma.gift.create({
      data: {
        senderId: req.userId!,
        recipientPhone: phone,
        recipientEmail: email,
        recipientName: body.recipientName?.trim() || null,
        amountKobo,
        message: body.message,
        claimCode,
        tenorDays,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Prefer matching an existing Kipit user by email, then phone.
    let existing =
      email
        ? await prisma.user.findFirst({
            where: { email, id: { not: req.userId! } },
          })
        : null;
    if (!existing && phone) {
      const variants = giftPhoneVariants(phone);
      existing = await prisma.user.findFirst({
        where: { phone: { in: variants }, id: { not: req.userId! } },
      });
    }

    let claimedPlacementId: string | null = null;
    if (existing) {
      try {
        const claimed = await claimGiftForUser(existing.id, gift.claimCode);
        claimedPlacementId = claimed.placementId;
      } catch {
        /* leave pending for manual claim */
      }
    }

    const claimLink = giftClaimLink(gift.claimCode);
    const inviteEmail = email || existing?.email || null;
    if (!claimedPlacementId && inviteEmail) {
      const sender = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { firstName: true },
      });
      await sendGiftInviteEmail({
        to: inviteEmail,
        recipientName: body.recipientName,
        senderFirstName: sender?.firstName || "Someone",
        amountNaira: body.amount,
        claimCode: gift.claimCode,
        claimLink,
        message: body.message,
      }).catch((err) => console.warn("[gift-invite-email]", err));
    }

    await writeAudit({
      actorUserId: req.userId,
      action: "gift.created",
      entityType: "Gift",
      entityId: gift.id,
      after: {
        amount: body.amount,
        claimCode,
        autoClaimed: Boolean(claimedPlacementId),
        invited: Boolean(!claimedPlacementId && inviteEmail),
      },
    });

    res.status(201).json({
      data: {
        id: gift.id,
        claimCode: gift.claimCode,
        claimLink,
        amount: body.amount,
        status: claimedPlacementId ? "Claimed" : "Pending",
        tenorDays,
        invitedEmail: !claimedPlacementId && inviteEmail ? inviteEmail : null,
      },
    });
  }),
);
