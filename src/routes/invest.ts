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
  accruedInterestToDateKobo,
  moveCallToWallet,
  moveWalletToCall,
  creditWalletFrom,
  ensureSystemAccount,
} from "../services/money.js";
import { debitWallet } from "../services/money.js";
import { writeAudit } from "../services/audit.js";
import { rejectIfMaintenance } from "../middleware/maintenance.js";
import {
  AUTO_INVEST_FREQUENCIES,
  formatNextRun,
  isAutoInvestFrequency,
  nextAutoInvestRunAt,
  resolveFrequency,
  stripFrequencyPrefix,
  type AutoInvestFrequency,
} from "../lib/auto-invest.js";
import {
  displayPlanName,
  listLockFlexRates,
  PLAN_MIN_NAIRA,
  resolvePlanRate,
  FLEX_BREAK_MIN_DAYS,
} from "../services/lock-flex-rates.js";
import {
  formatRatePair,
  interestBreakdownFromNetRate,
  interestBreakdownFromNetAmount,
} from "../services/wht.js";

export const investRouter = Router();
investRouter.use(rejectIfMaintenance);

function rateForTenorDays(
  days: number,
  bands: { code: string; minDays: number; maxDays: number | null; rateBps: number; family?: string | null }[],
) {
  const legacy = bands.filter((b) => !b.family);
  const pool = legacy.length ? legacy : bands;
  const band = pool.find((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  if (!band) throw new AppError(400, "No rate band for tenor", "RATE_BAND_MISSING");
  return band;
}

investRouter.get(
  "/rates",
  asyncHandler(async (_req, res) => {
    const rates = await listLockFlexRates();
    const call = rates.find((r) => r.family === "CALL");
    const lock = rates.filter((r) => r.family === "LOCK");
    const flex = rates.filter((r) => r.family === "FLEX");
    res.json({
      data: {
        minimum: PLAN_MIN_NAIRA,
        call: call
          ? {
              code: call.code,
              label: "Call Account",
              rateBps: call.rateBps,
              ratePct: call.ratePct,
              grossRatePct: call.grossRatePct,
              rateLabel: call.rateLabel,
              minimum: PLAN_MIN_NAIRA,
            }
          : null,
        lock: {
          title: "Kipit Lock",
          subtitle: "Our highest rates, locked till maturity.",
          tenors: lock
            .filter((r) => r.payout === "AT_MATURITY")
            .map((r) => ({
              days: r.standardTenorDays,
              atMaturity: r,
              upfront: lock.find(
                (u) => u.standardTenorDays === r.standardTenorDays && u.payout === "UPFRONT",
              ),
            })),
          customMinDays: 31,
          customMaxDays: 365,
        },
        flex: {
          title: "Kipit Flex",
          subtitle: "A fixed rate, with a way out after 30 days.",
          tenors: flex.map((r) => ({
            days: r.standardTenorDays,
            atMaturity: r,
          })),
          customMinDays: 31,
          customMaxDays: 365,
          breakAfterDays: FLEX_BREAK_MIN_DAYS,
        },
        bands: rates.map((r) => ({
          id: r.code,
          code: r.code,
          label: r.label,
          family: r.family,
          payout: r.payout,
          minDays: r.minDays,
          maxDays: r.maxDays,
          rateBps: r.rateBps,
          ratePct: r.ratePct,
          grossRatePct: r.grossRatePct,
          rateLabel: r.rateLabel,
          minimum: PLAN_MIN_NAIRA,
        })),
      },
    });
  }),
);

investRouter.get(
  "/call",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const call = await ensureUserCall(req.userId!);
    const callBand = await prisma.rateBand.findFirst({ where: { code: "CALL" } });
    const rateBps = callBand?.rateBps ?? 80_000; // Appendix D 8% net
    const pair = formatRatePair(rateBps);
    const { getOpsLimits } = await import("../services/system-settings.js");
    const ops = await getOpsLimits();
    res.json({
      data: {
        balance: koboToNaira(call.balanceKobo),
        balanceKobo: call.balanceKobo.toString(),
        rateBps,
        ratePct: pair.netRatePct,
        grossRatePct: pair.grossRatePct,
        rateLabel: pair.label,
        minimum: Math.min(ops.minCallDeposit, PLAN_MIN_NAIRA),
        liquidity: "Withdraw anytime",
        custodianNote:
          "Your Call Account and wallet balances are held and administered by Rand Merchant Bank, our custodian.",
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
    const { getOpsLimits } = await import("../services/system-settings.js");
    const ops = await getOpsLimits();
    if (body.amount < ops.minCallDeposit) {
      throw new AppError(
        400,
        `Minimum Call Account deposit is ₦${ops.minCallDeposit.toLocaleString("en-NG")}`,
        "BELOW_MINIMUM",
      );
    }
    const { interestValueDate } = await import("../services/system-settings.js");
    const value = await interestValueDate();
    await moveWalletToCall(req.userId!, nairaToKobo(body.amount), body.idempotencyKey);
    const call = await ensureUserCall(req.userId!);
    const { createUserNotification } = await import("../services/notify.js");
    await createUserNotification({
      userId: req.userId!,
      title: "Added to Call Account",
      body: `₦${body.amount.toLocaleString()} moved from your wallet into Call Account.${
        value.sameDay
          ? " Interest starts today."
          : ` Interest starts ${value.valueDate} (after ${value.cutoff} Lagos value cut-off).`
      }`,
      href: "/call-account",
      pushKind: "investment",
      emailKind: "investment",
      amountNaira: body.amount,
      emailDetail: value.sameDay
        ? "Call Account top-up — interest starts today"
        : `Call Account top-up — interest starts ${value.valueDate}`,
    }).catch(() => undefined);
    res.status(201).json({
      data: {
        balance: koboToNaira(call.balanceKobo),
        balanceKobo: call.balanceKobo.toString(),
        interestStartsOn: value.valueDate,
        sameDayInterest: value.sameDay,
        valueDateCutoff: value.cutoff,
      },
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
        planType: z.enum(["LOCK", "FLEX"]).default("LOCK"),
        interestPayout: z.enum(["AT_MATURITY", "UPFRONT"]).default("AT_MATURITY"),
      })
      .parse(req.body);
    const { rateBps, band } = await resolvePlanRate({
      planType: body.planType,
      tenorDays: body.tenorDays,
      interestPayout: body.interestPayout,
    });
    const principal = nairaToKobo(body.amount);
    const breakdown = interestBreakdownFromNetRate(principal, rateBps, body.tenorDays);
    const pair = formatRatePair(rateBps);
    const maturity = new Date(Date.now() + body.tenorDays * 86_400_000);
    const valueAtMaturity =
      body.interestPayout === "UPFRONT" ? principal : principal + breakdown.netKobo;
    res.json({
      data: {
        amount: body.amount,
        tenorDays: body.tenorDays,
        planType: body.planType,
        interestPayout: body.interestPayout,
        rateBps,
        ratePct: pair.netRatePct,
        grossRatePct: pair.grossRatePct,
        rateLabel: pair.label,
        grossInterest: koboToNaira(breakdown.grossKobo),
        withholdingTax: koboToNaira(breakdown.whtKobo),
        netInterest: koboToNaira(breakdown.netKobo),
        expectedInterest: koboToNaira(breakdown.netKobo),
        expectedPayout: koboToNaira(valueAtMaturity),
        valueAtMaturity: koboToNaira(valueAtMaturity),
        maturityDate: maturity.toISOString().slice(0, 10),
        band: band.code,
        minimum: PLAN_MIN_NAIRA,
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
        planType: z.enum(["LOCK", "FLEX"]).default("LOCK"),
        interestPayout: z.enum(["AT_MATURITY", "UPFRONT"]).default("AT_MATURITY"),
        name: z.string().min(1).optional(),
        goalAmount: z.number().positive().optional(),
        maturityInstruction: z.enum(["WALLET", "ROLLOVER", "PAYOUT"]).default("WALLET"),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
        isGift: z.boolean().optional(),
        consentVersion: z.string().min(1).optional(),
      })
      .parse(req.body);

    await verifyTransactionPin(req.userId!, body.pin);
    const payout = body.planType === "FLEX" ? "AT_MATURITY" : body.interestPayout;
    if (body.amount < PLAN_MIN_NAIRA) {
      throw new AppError(
        400,
        `Minimum fixed placement is ₦${PLAN_MIN_NAIRA.toLocaleString("en-NG")}`,
        "BELOW_MINIMUM",
      );
    }
    const { rateBps } = await resolvePlanRate({
      planType: body.planType,
      tenorDays: body.tenorDays,
      interestPayout: payout,
    });
    const amountKobo = nairaToKobo(body.amount);
    const planName =
      body.name && body.name !== "My plan"
        ? body.name
        : displayPlanName(body.planType, body.tenorDays);
    const breakdown = interestBreakdownFromNetRate(amountKobo, rateBps, body.tenorDays);

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
      description: `Fixed plan: ${planName}`,
      creditAccountId: placementAccount.id,
    });

    // Maturity = invest clock time + tenor (same time of day), not midnight + next job day.
    const startDate = new Date();
    const maturityDate = new Date(startDate.getTime() + body.tenorDays * 86_400_000);

    const placement = await prisma.placement.create({
      data: {
        userId: req.userId!,
        kind: "FIXED",
        name: planName,
        principalKobo: amountKobo,
        rateBps,
        tenorDays: body.tenorDays,
        startDate,
        maturityDate,
        maturityInstruction: body.maturityInstruction,
        goalKobo: body.goalAmount ? nairaToKobo(body.goalAmount) : null,
        isGift: body.isGift ?? false,
        ledgerAccountId: placementAccount.id,
        planType: body.planType,
        interestPayout: payout,
        lastTopUpAt: startDate,
      },
    });

    // Lock upfront: pay net interest to wallet on day one; WHT accounted as deducted.
    if (payout === "UPFRONT" && breakdown.netKobo > 0n) {
      const interestPool = await ensureSystemAccount("SYSTEM_INTEREST");
      await creditWalletFrom({
        userId: req.userId!,
        amountKobo: breakdown.netKobo,
        kind: "INTEREST",
        idempotencyKey: `${body.idempotencyKey}:upfront`,
        description: `Upfront interest: ${planName}`,
        debitAccountId: interestPool.id,
        metadata: {
          placementId: placement.id,
          grossKobo: breakdown.grossKobo.toString(),
          whtKobo: breakdown.whtKobo.toString(),
          netKobo: breakdown.netKobo.toString(),
        },
      });
    }

    if (body.consentVersion) {
      await prisma.consentAcceptance
        .create({
          data: {
            userId: req.userId!,
            docKey: body.planType === "FLEX" ? "product_terms_flex" : "product_terms_lock",
            version: body.consentVersion,
          },
        })
        .catch(() => undefined);
    }

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
      body: `₦${body.amount.toLocaleString()} invested in ${planName}.`,
      href: "/portfolio",
      emailKind: "investment",
      amountNaira: body.amount,
      emailDetail: `${planName} · ${body.tenorDays} days`,
    }).catch(() => undefined);

    const pair = formatRatePair(rateBps);
    const valueAtMaturity =
      payout === "UPFRONT" ? amountKobo : amountKobo + breakdown.netKobo;

    res.status(201).json({
      data: {
        id: placement.id,
        name: placement.name,
        planType: body.planType,
        interestPayout: payout,
        amount: body.amount,
        ratePct: pair.netRatePct,
        grossRatePct: pair.grossRatePct,
        rateLabel: pair.label,
        tenorDays: body.tenorDays,
        startDate: startDate.toISOString(),
        maturityDate: maturityDate.toISOString(),
        grossInterest: koboToNaira(breakdown.grossKobo),
        withholdingTax: koboToNaira(breakdown.whtKobo),
        netInterest: koboToNaira(breakdown.netKobo),
        expectedInterest: koboToNaira(breakdown.netKobo),
        valueAtMaturity: koboToNaira(valueAtMaturity),
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
      data: items.map((p) => {
        const planType = p.planType ?? (p.kind === "FIXED" ? "LOCK" : null);
        const payout = p.interestPayout ?? "AT_MATURITY";
        const displayName =
          p.kind === "FIXED" ? displayPlanName(planType, p.tenorDays) : p.name;
        const pair = formatRatePair(p.rateBps);
        const expectedNet =
          p.interestOverrideKobo != null
            ? interestBreakdownFromNetAmount(p.interestOverrideKobo, p.rateBps)
            : p.tenorDays != null
              ? interestBreakdownFromNetRate(p.principalKobo, p.rateBps, p.tenorDays)
              : null;
        const accruedNet = accruedInterestToDateKobo(p);
        const accruedBd = interestBreakdownFromNetAmount(accruedNet, p.rateBps);
        const valueAtMaturity =
          payout === "UPFRONT"
            ? p.principalKobo
            : expectedNet
              ? p.principalKobo + expectedNet.netKobo
              : p.principalKobo;
        return {
          id: p.id,
          kind: p.kind,
          name: displayName,
          planType,
          interestPayout: payout,
          status: p.status,
          principal: koboToNaira(p.principalKobo),
          ratePct: pair.netRatePct,
          grossRatePct: pair.grossRatePct,
          rateLabel: pair.label,
          tenorDays: p.tenorDays,
          startDate: p.startDate.toISOString().slice(0, 10),
          maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
          accrued: koboToNaira(accruedNet),
          accruedGross: koboToNaira(accruedBd.grossKobo),
          accruedWht: koboToNaira(accruedBd.whtKobo),
          accruedNet: koboToNaira(accruedBd.netKobo),
          expectedInterest: expectedNet ? koboToNaira(expectedNet.netKobo) : null,
          expectedGross: expectedNet ? koboToNaira(expectedNet.grossKobo) : null,
          expectedWht: expectedNet ? koboToNaira(expectedNet.whtKobo) : null,
          expectedNet: expectedNet ? koboToNaira(expectedNet.netKobo) : null,
          valueAtMaturity: koboToNaira(valueAtMaturity),
          maturityInstruction: p.maturityInstruction,
          lastTopUpAt: p.lastTopUpAt?.toISOString() ?? null,
          breakRequestedAt: p.breakRequestedAt?.toISOString() ?? null,
        };
      }),
    });
  }),
);

/** B26 — top up an active Lock/Flex plan (prorates remaining days; resets Flex break clock). */
investRouter.post(
  "/placements/:id/top-up",
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
    if (body.amount < PLAN_MIN_NAIRA) {
      throw new AppError(
        400,
        `Minimum top-up is ₦${PLAN_MIN_NAIRA.toLocaleString("en-NG")}`,
        "BELOW_MINIMUM",
      );
    }
    const placement = await prisma.placement.findFirst({
      where: { id: String(req.params.id), userId: req.userId!, status: "ACTIVE", kind: "FIXED" },
    });
    if (!placement) throw new AppError(404, "Plan not found", "NOT_FOUND");
    if (!placement.maturityDate || !placement.tenorDays) {
      throw new AppError(400, "Plan cannot be topped up", "NOT_TOPUPABLE");
    }
    const now = new Date();
    const msLeft = placement.maturityDate.getTime() - now.getTime();
    const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
    if (msLeft <= 0) throw new AppError(400, "Plan has matured", "ALREADY_MATURED");

    const amountKobo = nairaToKobo(body.amount);
    if (!placement.ledgerAccountId) {
      throw new AppError(400, "Plan ledger missing", "LEDGER_MISSING");
    }
    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "PLACEMENT",
      idempotencyKey: body.idempotencyKey,
      description: `Top-up: ${placement.name}`,
      creditAccountId: placement.ledgerAccountId,
    });

    const payout = placement.interestPayout ?? "AT_MATURITY";
    const topUpInterest = interestBreakdownFromNetRate(amountKobo, placement.rateBps, daysLeft);

    // Lock upfront: credit net interest for remaining days on the top-up amount.
    if (payout === "UPFRONT" && topUpInterest.netKobo > 0n) {
      const interestPool = await ensureSystemAccount("SYSTEM_INTEREST");
      await creditWalletFrom({
        userId: req.userId!,
        amountKobo: topUpInterest.netKobo,
        kind: "INTEREST",
        idempotencyKey: `${body.idempotencyKey}:upfront`,
        description: `Upfront interest on top-up: ${placement.name}`,
        debitAccountId: interestPool.id,
        metadata: {
          placementId: placement.id,
          daysLeft,
          grossKobo: topUpInterest.grossKobo.toString(),
          whtKobo: topUpInterest.whtKobo.toString(),
          netKobo: topUpInterest.netKobo.toString(),
        },
      });
    }

    const updated = await prisma.placement.update({
      where: { id: placement.id },
      data: {
        principalKobo: placement.principalKobo + amountKobo,
        lastTopUpAt: now,
        // Clear any pending break so Flex lock restarts from this top-up.
        breakRequestedAt: null,
        breakCreditAt: null,
      },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "placement.top_up",
      entityType: "Placement",
      entityId: placement.id,
    });

    const pair = formatRatePair(updated.rateBps);
    res.status(201).json({
      data: {
        id: updated.id,
        principal: koboToNaira(updated.principalKobo),
        topUpAmount: body.amount,
        daysLeft,
        ratePct: pair.netRatePct,
        grossRatePct: pair.grossRatePct,
        upfrontInterest:
          payout === "UPFRONT" ? koboToNaira(topUpInterest.netKobo) : 0,
        lastTopUpAt: updated.lastTopUpAt?.toISOString() ?? null,
      },
    });
  }),
);

/** B8 — request Flex early break (50% of accrued forfeited; credit within 3 business days). */
investRouter.post(
  "/placements/:id/break",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);
    await verifyTransactionPin(req.userId!, body.pin);
    const placement = await prisma.placement.findFirst({
      where: { id: String(req.params.id), userId: req.userId!, status: "ACTIVE", kind: "FIXED" },
    });
    if (!placement) throw new AppError(404, "Plan not found", "NOT_FOUND");
    const planType = placement.planType ?? "LOCK";
    if (planType !== "FLEX") {
      throw new AppError(400, "Only Kipit Flex plans can be broken early", "NOT_FLEX");
    }
    if (placement.breakRequestedAt) {
      throw new AppError(400, "Break already requested", "BREAK_PENDING");
    }
    const anchor = placement.lastTopUpAt ?? placement.startDate;
    const daysSince = Math.floor((Date.now() - anchor.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSince < FLEX_BREAK_MIN_DAYS) {
      const available = new Date(anchor);
      available.setUTCDate(available.getUTCDate() + FLEX_BREAK_MIN_DAYS);
      throw new AppError(
        400,
        `Break available from ${available.toISOString().slice(0, 10)}`,
        "BREAK_TOO_EARLY",
      );
    }

    const accruedNet = accruedInterestToDateKobo(placement);
    const accruedBd = interestBreakdownFromNetAmount(accruedNet, placement.rateBps);
    const forfeitedNet = accruedNet / 2n;
    const creditedNet = accruedNet - forfeitedNet;
    const creditedBd = interestBreakdownFromNetAmount(creditedNet, placement.rateBps);
    // Credit date: +3 calendar days as proxy for 3 business days (job can refine).
    const creditAt = new Date();
    creditAt.setUTCDate(creditAt.getUTCDate() + 3);

    // Stay ACTIVE until credit job runs; breakRequestedAt marks the request.
    await prisma.placement.update({
      where: { id: placement.id },
      data: {
        breakRequestedAt: new Date(),
        breakCreditAt: creditAt,
      },
    });

    const { notifyCustomer } = await import("../services/notify.js");
    await notifyCustomer({
      userId: req.userId!,
      title: "Flex break requested",
      body: `We'll credit ₦${koboToNaira(placement.principalKobo + creditedNet).toLocaleString()} to your wallet by ${creditAt.toISOString().slice(0, 10)}.`,
      href: "/portfolio",
      emailKind: "investment",
      amountNaira: koboToNaira(placement.principalKobo + creditedNet),
      emailDetail: `Flex break · 50% interest forfeited · expected ${creditAt.toISOString().slice(0, 10)}`,
    }).catch(() => undefined);

    await writeAudit({
      actorUserId: req.userId,
      action: "placement.break_request",
      entityType: "Placement",
      entityId: placement.id,
      after: { idempotencyKey: body.idempotencyKey, creditAt: creditAt.toISOString() },
    });

    res.status(201).json({
      data: {
        id: placement.id,
        principal: koboToNaira(placement.principalKobo),
        accruedGross: koboToNaira(accruedBd.grossKobo),
        accruedWht: koboToNaira(accruedBd.whtKobo),
        accruedNet: koboToNaira(accruedBd.netKobo),
        forfeitedNet: koboToNaira(forfeitedNet),
        creditedInterestNet: koboToNaira(creditedNet),
        creditedInterestGross: koboToNaira(creditedBd.grossKobo),
        creditedInterestWht: koboToNaira(creditedBd.whtKobo),
        creditAmount: koboToNaira(placement.principalKobo + creditedNet),
        expectedCreditDate: creditAt.toISOString().slice(0, 10),
        breakRequestedAt: new Date().toISOString(),
      },
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
        const frequency = resolveFrequency(r.frequency, r.label);
        return {
          id: r.id,
          label: stripFrequencyPrefix(r.label),
          amount: koboToNaira(r.amountKobo),
          dayOfMonth: r.dayOfMonth,
          active: r.active,
          frequency,
          nextRun: r.active
            ? formatNextRun(frequency, r.nextRunAt ?? nextAutoInvestRunAt(frequency, r.dayOfMonth))
            : null,
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
        frequency: z.enum(AUTO_INVEST_FREQUENCIES).optional(),
      })
      .parse(req.body);
    const frequency = (body.frequency && isAutoInvestFrequency(body.frequency)
      ? body.frequency
      : "Monthly") as AutoInvestFrequency;
    // Keep label prefix so older app builds that only parse the label still work.
    const label = `${frequency} · ${body.label}`;
    const nextRunAt = nextAutoInvestRunAt(frequency, body.dayOfMonth);
    const rule = await prisma.autoInvestRule.create({
      data: {
        userId: req.userId!,
        label,
        amountKobo: nairaToKobo(body.amount),
        dayOfMonth: body.dayOfMonth,
        frequency,
        nextRunAt,
      },
    });
    res.status(201).json({
      data: {
        id: rule.id,
        frequency,
        nextRun: formatNextRun(frequency, rule.nextRunAt),
      },
    });
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
    const frequency = resolveFrequency(existing.frequency, existing.label);
    const data: { active: boolean; nextRunAt?: Date | null } = { active: body.active };
    if (body.active) {
      // Resume: schedule next run from now if missing or already past.
      if (!existing.nextRunAt || existing.nextRunAt.getTime() <= Date.now()) {
        data.nextRunAt = nextAutoInvestRunAt(frequency, existing.dayOfMonth);
      }
    }
    const rule = await prisma.autoInvestRule.update({
      where: { id: existing.id },
      data,
    });
    res.json({
      data: {
        id: rule.id,
        label: stripFrequencyPrefix(rule.label),
        amount: koboToNaira(rule.amountKobo),
        dayOfMonth: rule.dayOfMonth,
        active: rule.active,
        frequency,
        nextRun: rule.active
          ? formatNextRun(frequency, rule.nextRunAt ?? nextAutoInvestRunAt(frequency, rule.dayOfMonth))
          : null,
      },
    });
  }),
);
