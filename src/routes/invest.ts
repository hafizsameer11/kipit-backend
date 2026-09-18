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
import {
  ensureUserCall,
  ensureUserWallet,
  getWalletBalanceKobo,
  interestForPeriod,
  moveCallToWallet,
  moveWalletToCall,
} from "../services/money.js";
import { debitWallet } from "../services/money.js";
import { writeAudit } from "../services/audit.js";

export const investRouter = Router();

function rateForTenorDays(
  days: number,
  bands: { code: string; minDays: number; maxDays: number | null; rateBps: number }[],
) {
  const band = bands.find((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  if (!band) throw new AppError(400, "No rate band for tenor", "RATE_BAND_MISSING");
  return band;
}

investRouter.get(
  "/rates",
  asyncHandler(async (_req, res) => {
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" } });
    res.json({
      data: bands.map((b) => ({
        id: b.id,
        code: b.code,
        label: b.label,
        minDays: b.minDays,
        maxDays: b.maxDays,
        rateBps: b.rateBps,
        ratePct: b.rateBps / 100,
      })),
    });
  }),
);

investRouter.get(
  "/call",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const call = await ensureUserCall(req.userId!);
    const callBand = await prisma.rateBand.findFirst({ where: { code: "CALL" } });
    const rateBps = callBand?.rateBps ?? 1450;
    res.json({
      data: {
        balance: koboToNaira(call.balanceKobo),
        balanceKobo: call.balanceKobo.toString(),
        rateBps,
        ratePct: rateBps / 100,
        minimum: 1000,
        liquidity: "Withdraw anytime",
      },
    });
  }),
);

investRouter.post(
  "/call/deposit",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);
    await verifyTransactionPin(req.userId!, body.pin);
    await moveWalletToCall(req.userId!, nairaToKobo(body.amount), body.idempotencyKey);
    const call = await ensureUserCall(req.userId!);
    res.status(201).json({
      data: { balance: koboToNaira(call.balanceKobo), balanceKobo: call.balanceKobo.toString() },
    });
  }),
);

investRouter.post(
  "/call/withdraw",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);
    await verifyTransactionPin(req.userId!, body.pin);
    await moveCallToWallet(req.userId!, nairaToKobo(body.amount), body.idempotencyKey);
    const wallet = await getWalletBalanceKobo(req.userId!);
    res.status(201).json({
      data: { walletBalance: koboToNaira(wallet), walletBalanceKobo: wallet.toString() },
    });
  }),
);

investRouter.post(
  "/calculator",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        tenorDays: z.number().int().positive(),
      })
      .parse(req.body);
    const bands = await prisma.rateBand.findMany();
    const band = rateForTenorDays(body.tenorDays, bands);
    const principal = nairaToKobo(body.amount);
    const interest = interestForPeriod(principal, band.rateBps, body.tenorDays);
    const maturity = new Date();
    maturity.setDate(maturity.getDate() + body.tenorDays);
    res.json({
      data: {
        amount: body.amount,
        tenorDays: body.tenorDays,
        rateBps: band.rateBps,
        ratePct: band.rateBps / 100,
        expectedInterest: koboToNaira(interest),
        expectedPayout: koboToNaira(principal + interest),
        maturityDate: maturity.toISOString().slice(0, 10),
        band: band.code,
      },
    });
  }),
);

investRouter.post(
  "/fixed-plans",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        tenorDays: z.number().int().positive(),
        name: z.string().min(1).default("My plan"),
        goalAmount: z.number().positive().optional(),
        maturityInstruction: z.enum(["WALLET", "ROLLOVER", "PAYOUT"]).default("WALLET"),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
        isGift: z.boolean().optional(),
      })
      .parse(req.body);

    await verifyTransactionPin(req.userId!, body.pin);
    const bands = await prisma.rateBand.findMany();
    const band = rateForTenorDays(body.tenorDays, bands);
    const amountKobo = nairaToKobo(body.amount);

    const placementTag = `placement_${nanoid(10)}`;
    const placementAccount = await prisma.ledgerAccount.create({
      data: {
        userId: req.userId!,
        type: "USER_PLACEMENT",
        tag: placementTag,
        currency: "NGN",
        balanceKobo: 0n,
      },
    });

    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "PLACEMENT",
      idempotencyKey: body.idempotencyKey,
      description: `Fixed plan: ${body.name}`,
      creditAccountId: placementAccount.id,
    });

    const maturityDate = new Date();
    maturityDate.setDate(maturityDate.getDate() + body.tenorDays);

    const placement = await prisma.placement.create({
      data: {
        userId: req.userId!,
        kind: "FIXED",
        name: body.name,
        principalKobo: amountKobo,
        rateBps: band.rateBps,
        tenorDays: body.tenorDays,
        maturityDate,
        maturityInstruction: body.maturityInstruction,
        goalKobo: body.goalAmount ? nairaToKobo(body.goalAmount) : null,
        isGift: body.isGift ?? false,
        ledgerAccountId: placementAccount.id,
      },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "placement.create_fixed",
      entityType: "Placement",
      entityId: placement.id,
    });

    res.status(201).json({
      data: {
        id: placement.id,
        name: placement.name,
        amount: body.amount,
        ratePct: band.rateBps / 100,
        tenorDays: body.tenorDays,
        maturityDate: maturityDate.toISOString().slice(0, 10),
        expectedInterest: koboToNaira(interestForPeriod(amountKobo, band.rateBps, body.tenorDays)),
      },
    });
  }),
);

investRouter.get(
  "/placements",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const items = await prisma.placement.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: items.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        status: p.status,
        principal: koboToNaira(p.principalKobo),
        ratePct: p.rateBps / 100,
        tenorDays: p.tenorDays,
        maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
        accrued: koboToNaira(p.accruedKobo),
      })),
    });
  }),
);

investRouter.get(
  "/auto-invest",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const rules = await prisma.autoInvestRule.findMany({ where: { userId: req.userId! } });
    res.json({
      data: rules.map((r) => ({
        id: r.id,
        label: r.label,
        amount: koboToNaira(r.amountKobo),
        dayOfMonth: r.dayOfMonth,
        active: r.active,
      })),
    });
  }),
);

investRouter.post(
  "/auto-invest",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        label: z.string().min(1),
        amount: z.number().positive(),
        dayOfMonth: z.number().int().min(1).max(28),
      })
      .parse(req.body);
    const rule = await prisma.autoInvestRule.create({
      data: {
        userId: req.userId!,
        label: body.label,
        amountKobo: nairaToKobo(body.amount),
        dayOfMonth: body.dayOfMonth,
      },
    });
    res.status(201).json({ data: { id: rule.id } });
  }),
);
