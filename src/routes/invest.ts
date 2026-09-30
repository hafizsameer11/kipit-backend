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

/** Investment minimums (naira) by band code — mirrored in the mobile app as fallback. */
const BAND_MINIMUM_NAIRA: Record<string, number> = {
  CALL: 5_000,
  "1-90": 10_000,
  "91-120": 50_000,
  "121-180": 50_000,
  "181-364": 100_000,
  "365+": 250_000,
};

const BAND_PRODUCT_NAMES: Record<string, string> = {
  CALL: "Kipit Call Account",
  "1-90": "Kipit Starter",
  "91-120": "Kipit Fixed Income",
  "121-180": "Kipit Target Savings",
  "181-364": "Kipit Growth",
  "365+": "Kipit Vault",
};

function minimumForBand(code: string, minDays: number) {
  if (BAND_MINIMUM_NAIRA[code] != null) return BAND_MINIMUM_NAIRA[code];
  if (minDays <= 0) return 5_000;
  if (minDays <= 90) return 10_000;
  if (minDays <= 180) return 50_000;
  if (minDays <= 364) return 100_000;
  return 250_000;
}

function productLabelForBand(code: string, fallback: string) {
  return BAND_PRODUCT_NAMES[code] ?? fallback;
}

investRouter.get(
  "/rates",
  asyncHandler(async (_req, res) => {
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" } });
    res.json({
      data: bands.map((b) => ({
        id: b.id,
        code: b.code,
        label: productLabelForBand(b.code, b.label),
        minDays: b.minDays,
        maxDays: b.maxDays,
        rateBps: b.rateBps,
        ratePct: b.rateBps / 100,
        minimum: minimumForBand(b.code, b.minDays),
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
    const { createUserNotification } = await import("../services/notify.js");
    await createUserNotification({
      userId: req.userId!,
      title: "Added to Call Account",
      body: `₦${body.amount.toLocaleString()} moved from your wallet into Call Account.`,
      href: "/call-account",
      pushKind: "investment",
      emailKind: "investment",
      amountNaira: body.amount,
      emailDetail: "Call Account top-up",
    }).catch(() => undefined);
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
    const { createUserNotification } = await import("../services/notify.js");
    await createUserNotification({
      userId: req.userId!,
      title: "Moved to wallet",
      body: `₦${body.amount.toLocaleString()} moved from Call Account into your wallet.`,
      href: "/wallet",
      pushKind: "deposit",
      emailKind: "deposit",
      amountNaira: body.amount,
      emailDetail: "From Call Account",
    }).catch(() => undefined);
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

    const { notifyCustomer } = await import("../services/notify.js");
    await notifyCustomer({
      userId: req.userId!,
      title: "Investment confirmed",
      body: `₦${body.amount.toLocaleString()} invested in ${body.name}.`,
      href: "/portfolio",
      emailKind: "investment",
      amountNaira: body.amount,
      emailDetail: `${body.name} · ${body.tenorDays} days`,
    }).catch(() => undefined);

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
        maturityInstruction: p.maturityInstruction,
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
      data: rules.map((r) => {
        const freqMatch = r.label.match(/^(Weekly|Every 2 weeks|Monthly)\s*·\s*(.*)$/);
        return {
          id: r.id,
          label: freqMatch ? freqMatch[2] : r.label,
          amount: koboToNaira(r.amountKobo),
          dayOfMonth: r.dayOfMonth,
          active: r.active,
          frequency: freqMatch ? freqMatch[1] : "Monthly",
        };
      }),
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
        frequency: z.enum(["Weekly", "Every 2 weeks", "Monthly"]).optional(),
      })
      .parse(req.body);
    const label = body.frequency ? `${body.frequency} · ${body.label}` : body.label;
    const rule = await prisma.autoInvestRule.create({
      data: {
        userId: req.userId!,
        label,
        amountKobo: nairaToKobo(body.amount),
        dayOfMonth: body.dayOfMonth,
      },
    });
    res.status(201).json({ data: { id: rule.id, frequency: body.frequency ?? "Monthly" } });
  }),
);

investRouter.patch(
  "/auto-invest/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const existing = await prisma.autoInvestRule.findFirst({
      where: { id: String(req.params.id), userId: req.userId! },
    });
    if (!existing) throw new AppError(404, "Auto-invest rule not found", "NOT_FOUND");
    const rule = await prisma.autoInvestRule.update({
      where: { id: existing.id },
      data: { active: body.active },
    });
    res.json({
      data: {
        id: rule.id,
        label: rule.label,
        amount: koboToNaira(rule.amountKobo),
        dayOfMonth: rule.dayOfMonth,
        active: rule.active,
      },
    });
  }),
);
