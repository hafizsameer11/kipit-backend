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
import {
  claimGiftForUser,
  claimPendingGiftsForUser,
  giftClaimLink,
  giftPhoneVariants,
  publicGiftPreview,
} from "../services/gifts.js";

export const giftsRouter = Router();

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
    recipient: { firstName: string; surname: string; phone: string | null } | null;
    sender?: { firstName: string; surname: string } | null;
  },
  viewerId: string,
) {
  return {
    id: g.id,
    recipient: g.recipient
      ? `${g.recipient.firstName} ${g.recipient.surname}`
      : g.recipientName ?? g.recipientPhone ?? "Pending recipient",
    phone: g.recipientPhone ?? g.recipient?.phone ?? "—",
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
    const body = z
      .object({
        amount: z.number().positive(),
        recipientPhone: z.string().min(7),
        recipientName: z.string().optional(),
        message: z.string().max(280).optional(),
        tenorDays: z.number().int().positive().optional(),
        pin: z.string().min(4),
      })
      .parse(req.body);

    await verifyTransactionPin(req.userId!, body.pin);
    const amountKobo = nairaToKobo(body.amount);
    const claimCode = `GFT-${nanoid(8).toUpperCase()}`;
    const tenorDays = body.tenorDays && body.tenorDays > 0 ? body.tenorDays : 90;
    const phone =
      giftPhoneVariants(body.recipientPhone)[0] ?? body.recipientPhone.replace(/\D/g, "");

    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "WITHDRAWAL",
      idempotencyKey: `gift-${claimCode}`,
      description: `Gift investment to ${phone}`,
      creditAccountId: suspense.id,
      metadata: { claimCode, gift: true, tenorDays },
    });

    const gift = await prisma.gift.create({
      data: {
        senderId: req.userId!,
        recipientPhone: phone,
        recipientName: body.recipientName?.trim() || null,
        amountKobo,
        message: body.message,
        claimCode,
        tenorDays,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // If recipient already has a Kipit account with this phone, claim immediately.
    const variants = giftPhoneVariants(phone);
    const existing = await prisma.user.findFirst({
      where: { phone: { in: variants }, id: { not: req.userId! } },
    });
    let claimedPlacementId: string | null = null;
    if (existing) {
      try {
        const claimed = await claimGiftForUser(existing.id, gift.claimCode);
        claimedPlacementId = claimed.placementId;
      } catch {
        /* leave pending for manual claim */
      }
    }

    await writeAudit({
      actorUserId: req.userId,
      action: "gift.created",
      entityType: "Gift",
      entityId: gift.id,
      after: { amount: body.amount, claimCode, autoClaimed: Boolean(claimedPlacementId) },
    });

    const claimLink = giftClaimLink(gift.claimCode);
    res.status(201).json({
      data: {
        id: gift.id,
        claimCode: gift.claimCode,
        claimLink,
        amount: body.amount,
        status: claimedPlacementId ? "Claimed" : "Pending",
        tenorDays,
      },
    });
  }),
);
