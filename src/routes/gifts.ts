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
import { debitWallet, ensureSystemAccount } from "../services/money.js";
import { writeAudit } from "../services/audit.js";

export const giftsRouter = Router();

function mapGiftStatus(status: string): "Pending" | "Claimed" | "Expired" {
  if (status === "CLAIMED") return "Claimed";
  if (status === "EXPIRED" || status === "CANCELLED") return "Expired";
  return "Pending";
}

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
      data: rows.map((g) => ({
        id: g.id,
        recipient:
          g.recipient
            ? `${g.recipient.firstName} ${g.recipient.surname}`
            : g.recipientPhone ?? "Pending recipient",
        phone: g.recipientPhone ?? g.recipient?.phone ?? "—",
        product: g.placement?.name ?? "Gift investment",
        tenor: g.placement?.tenorDays ? `${g.placement.tenorDays} days` : "—",
        rate: g.placement ? `${(g.placement.rateBps / 100).toFixed(2)}%` : "—",
        amount: koboToNaira(g.amountKobo),
        message: g.message ?? "",
        sentDate: g.createdAt.toISOString().slice(0, 10),
        claimedDate: g.claimedAt?.toISOString().slice(0, 10),
        expiresDate: g.expiresAt?.toISOString().slice(0, 10),
        status: mapGiftStatus(g.status),
        maturityDate: g.placement?.maturityDate?.toISOString().slice(0, 10) ?? "—",
        expectedPayout: g.placement
          ? koboToNaira(g.placement.principalKobo + g.placement.accruedKobo)
          : koboToNaira(g.amountKobo),
        claimCode: g.claimCode,
        direction: g.senderId === req.userId ? "sent" : "received",
      })),
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
      include: { placement: true, recipient: true },
    });
    if (!g) throw new AppError(404, "Gift not found", "NOT_FOUND");
    res.json({
      data: {
        id: g.id,
        recipient:
          g.recipient
            ? `${g.recipient.firstName} ${g.recipient.surname}`
            : g.recipientPhone ?? "Pending recipient",
        phone: g.recipientPhone ?? g.recipient?.phone ?? "—",
        product: g.placement?.name ?? "Gift investment",
        tenor: g.placement?.tenorDays ? `${g.placement.tenorDays} days` : "—",
        rate: g.placement ? `${(g.placement.rateBps / 100).toFixed(2)}%` : "—",
        amount: koboToNaira(g.amountKobo),
        message: g.message ?? "",
        sentDate: g.createdAt.toISOString().slice(0, 10),
        claimedDate: g.claimedAt?.toISOString().slice(0, 10),
        expiresDate: g.expiresAt?.toISOString().slice(0, 10),
        status: mapGiftStatus(g.status),
        maturityDate: g.placement?.maturityDate?.toISOString().slice(0, 10) ?? "—",
        expectedPayout: koboToNaira(g.amountKobo),
        claimCode: g.claimCode,
      },
    });
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
        pin: z.string().min(4),
      })
      .parse(req.body);

    await verifyTransactionPin(req.userId!, body.pin);
    const amountKobo = nairaToKobo(body.amount);
    const claimCode = `GFT-${nanoid(8).toUpperCase()}`;

    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "WITHDRAWAL",
      idempotencyKey: `gift-${claimCode}`,
      description: `Gift investment to ${body.recipientPhone}`,
      creditAccountId: suspense.id,
      metadata: { claimCode, gift: true },
    });

    const gift = await prisma.gift.create({
      data: {
        senderId: req.userId!,
        recipientPhone: body.recipientPhone,
        amountKobo,
        message: body.message,
        claimCode,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "gift.created",
      entityType: "Gift",
      entityId: gift.id,
      after: { amount: body.amount, claimCode },
    });

    res.status(201).json({
      data: {
        id: gift.id,
        claimCode: gift.claimCode,
        amount: body.amount,
        status: "Pending",
      },
    });
  }),
);
