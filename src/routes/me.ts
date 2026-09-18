import { Router } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { publicUser } from "../services/auth.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";
import { koboToNaira } from "../lib/crypto.js";

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
    const invested =
      call.balanceKobo + placements.reduce((s, p) => s + p.principalKobo, 0n);
    const total = wallet.balanceKobo + invested;
    const next = placements.find((p) => p.maturityDate) ?? null;
    const feed = await prisma.feedCard.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      take: 10,
    });

    res.json({
      data: {
        greetingName: user.firstName,
        kycTier: user.kycTier,
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
        interestThisWeek: 0,
        nextMaturity: next?.maturityDate
          ? {
              id: next.id,
              name: next.name,
              amount: koboToNaira(next.principalKobo),
              date: next.maturityDate.toISOString().slice(0, 10),
              daysLeft: Math.max(
                0,
                Math.ceil((next.maturityDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
              ),
            }
          : null,
        holdings: placements.slice(0, 5).map((p) => ({
          id: p.id,
          name: p.name,
          amount: koboToNaira(p.principalKobo),
          ratePct: p.rateBps / 100,
          maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
        })),
        feed,
        user: publicUser(user),
      },
    });
  }),
);
