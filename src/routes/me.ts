import { Router } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { publicUser } from "../services/auth.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";
import { koboToNaira } from "../lib/crypto.js";
import { recordFeedImpressions } from "../services/feed-impressions.js";
import { portfolioInterestThisWeek } from "../lib/call-interest-week.js";
import { accruedInterestToDateKobo, placementInterestKobo } from "../services/money.js";
import { displayPlanName } from "../services/lock-flex-rates.js";
import { formatRatePair, interestBreakdownFromNetAmount } from "../services/wht.js";
import { isProfileComplete } from "./settings.js";

export const meRouter = Router();

meRouter.get(
  "/home",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const wallet = await ensureUserWallet(user.id);
    const call = await ensureUserCall(user.id);
    const placements = await prisma.placement.findMany({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { maturityDate: "asc" },
    });

    // B3 — portfolio = wallet + Call + principal + accrued on all plans
    let placementsMtm = 0n;
    let valueAtMaturityPlans = 0n;
    for (const p of placements) {
      const accrued = accruedInterestToDateKobo(p);
      placementsMtm += p.principalKobo + accrued;
      const payout = p.interestPayout ?? "AT_MATURITY";
      if (payout === "UPFRONT") {
        valueAtMaturityPlans += p.principalKobo;
      } else {
        valueAtMaturityPlans += p.principalKobo + placementInterestKobo(p);
      }
    }
    const invested = call.balanceKobo + placementsMtm;
    const total = wallet.balanceKobo + invested;
    const valueAtMaturity = wallet.balanceKobo + call.balanceKobo + valueAtMaturityPlans;
    const next = placements.find((p) => p.maturityDate) ?? null;
    const feed = await prisma.feedCard.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      take: 10,
    });
    void recordFeedImpressions(
      user.id,
      feed.map((card) => card.id),
    ).catch(() => undefined);

    const interestWeek = await portfolioInterestThisWeek(user.id);

    const holdingView = (p: (typeof placements)[number]) => {
      const planType = p.planType ?? (p.kind === "FIXED" ? "LOCK" : null);
      const name = p.kind === "FIXED" ? displayPlanName(planType, p.tenorDays) : p.name;
      const pair = formatRatePair(p.rateBps);
      const accrued = accruedInterestToDateKobo(p);
      const accruedBd = interestBreakdownFromNetAmount(accrued, p.rateBps);
      const expected = placementInterestKobo(p);
      const expectedBd = interestBreakdownFromNetAmount(expected, p.rateBps);
      const payout = p.interestPayout ?? "AT_MATURITY";
      const finalValue =
        payout === "UPFRONT" ? p.principalKobo : p.principalKobo + expected;
      const elapsed =
        p.tenorDays && p.tenorDays > 0
          ? Math.min(
              p.tenorDays,
              Math.max(
                0,
                Math.floor((Date.now() - p.startDate.getTime()) / (24 * 60 * 60 * 1000)),
              ),
            )
          : 0;
      return {
        id: p.id,
        name,
        planType,
        interestPayout: payout,
        amount: koboToNaira(p.principalKobo),
        ratePct: pair.netRatePct,
        grossRatePct: pair.grossRatePct,
        rateLabel: pair.label,
        tenorDays: p.tenorDays,
        maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
        startDate: p.startDate.toISOString().slice(0, 10),
        accrued: koboToNaira(accrued),
        accruedGross: koboToNaira(accruedBd.grossKobo),
        accruedWht: koboToNaira(accruedBd.whtKobo),
        expectedInterest: koboToNaira(expected),
        expectedGross: koboToNaira(expectedBd.grossKobo),
        expectedWht: koboToNaira(expectedBd.whtKobo),
        valueAtMaturity: koboToNaira(finalValue),
        progressPct: p.tenorDays && p.tenorDays > 0 ? Math.round((elapsed / p.tenorDays) * 100) : 0,
        daysElapsed: elapsed,
      };
    };

    res.json({
      data: {
        greetingName: user.firstName,
        kycTier: user.kycTier,
        frozen: user.frozen,
        frozenReason: user.frozenReason,
        profileComplete: isProfileComplete(user),
        wallet: {
          currency: "NGN",
          balanceKobo: wallet.balanceKobo.toString(),
          balance: koboToNaira(wallet.balanceKobo),
          earnsInterest: false,
        },
        invested: {
          currency: "NGN",
          balance: koboToNaira(invested),
          balanceKobo: invested.toString(),
        },
        total: {
          currency: "NGN",
          balance: koboToNaira(total),
          balanceKobo: total.toString(),
        },
        valueAtMaturity: koboToNaira(valueAtMaturity),
        // Overall portfolio interest (Call daily + maturity interest), last 7 Lagos days.
        interestThisWeek: interestWeek.interestThisWeek,
        interestToday: interestWeek.interestToday,
        callInterestToday: interestWeek.callInterestToday,
        interestWeekSeries: interestWeek.interestWeekSeries,
        interestWeekLabels: interestWeek.interestWeekLabels,
        nextMaturity: next?.maturityDate
          ? (() => {
              const h = holdingView(next);
              return {
                id: next.id,
                name: h.name,
                amount: h.amount,
                finalValue: h.valueAtMaturity,
                date: next.maturityDate!.toISOString().slice(0, 10),
                daysLeft: Math.max(
                  0,
                  Math.ceil((next.maturityDate!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
                ),
                tenorDays: next.tenorDays,
                ratePct: h.ratePct,
                grossRatePct: h.grossRatePct,
                startDate: h.startDate,
                accrued: h.accrued,
                expectedNet: h.expectedInterest,
                expectedGross: h.expectedGross,
                expectedWht: h.expectedWht,
              };
            })()
          : null,
        holdings: placements.slice(0, 5).map(holdingView),
        feed,
        user: publicUser(user),
      },
    });
  }),
);
