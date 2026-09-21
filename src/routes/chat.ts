import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import { ensureUserCall, getWalletBalanceKobo } from "../services/money.js";

export const chatRouter = Router();

/**
 * Ask AI — production shape matches web prototype:
 * read/recommend tools + secure handoff deep-links. Never moves money here.
 */
chatRouter.post(
  "/message",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        sessionId: z.string().optional(),
        text: z.string().min(1),
      })
      .parse(req.body);

    const session =
      (body.sessionId
        ? await prisma.chatSession.findFirst({
            where: { id: body.sessionId, userId: req.userId! },
          })
        : null) ??
      (await prisma.chatSession.create({ data: { userId: req.userId! } }));

    await prisma.chatMessage.create({
      data: { sessionId: session.id, role: "user", content: body.text },
    });

    const reply = await buildAssistantReply(req.userId!, body.text);

    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: reply.text,
        blocks: reply.blocks,
      },
    });

    res.json({
      data: {
        sessionId: session.id,
        message: {
          role: "assistant",
          text: reply.text,
          blocks: reply.blocks,
        },
      },
    });
  }),
);

async function buildAssistantReply(userId: string, raw: string) {
  const text = raw.toLowerCase();
  const wallet = await getWalletBalanceKobo(userId);
  const call = await ensureUserCall(userId);
  const placements = await prisma.placement.findMany({
    where: { userId, status: "ACTIVE" },
    orderBy: { maturityDate: "asc" },
  });
  const invested = placements.reduce((s, p) => s + p.principalKobo, 0n) + call.balanceKobo;
  const total = wallet + invested;

  if (/(balance|portfolio|worth|wallet)/.test(text)) {
    return {
      text: `Your current portfolio value is ₦${koboToNaira(total).toLocaleString()}.`,
      blocks: [
        { kind: "balance", wallet: koboToNaira(wallet), invested: koboToNaira(invested), total: koboToNaira(total) },
        { kind: "handoff", label: "View Portfolio", to: "/portfolio" },
      ],
    };
  }

  if (/(mature|maturity|payout date)/.test(text)) {
    const next = placements.find((p) => p.maturityDate);
    if (!next?.maturityDate) {
      return { text: "You have no upcoming maturities yet.", blocks: [{ kind: "handoff", label: "Explore products", to: "/explore" }] };
    }
    return {
      text: `Your next maturity is on ${next.maturityDate.toISOString().slice(0, 10)}.`,
      blocks: [
        {
          kind: "maturity",
          name: next.name,
          date: next.maturityDate.toISOString().slice(0, 10),
          amount: koboToNaira(next.principalKobo),
          rate: `${next.rateBps / 100}% p.a.`,
          daysLeft: Math.max(
            0,
            Math.ceil((next.maturityDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
          ),
          expectedPayout: koboToNaira(next.principalKobo + next.accruedKobo),
        },
        { kind: "handoff", label: "View holding", to: `/portfolio/${next.id}` },
      ],
    };
  }

  if (/(fund|add money|top up|top-up)/.test(text)) {
    return {
      text: "You can fund your Kipit wallet by bank transfer or card.",
      blocks: [{ kind: "handoff", label: "Add Money", to: "/wallet/add-money" }],
    };
  }

  if (/(withdraw|withdrawal)/.test(text)) {
    return {
      text: "Withdrawals need Tier 2 verification and go through a secure review flow.",
      blocks: [{ kind: "handoff", label: "Continue Securely", to: "/withdraw" }],
    };
  }

  if (/(invest|plan|product|rate)/.test(text)) {
    const products = await prisma.product.findMany({
      where: { availability: "OPEN" },
      take: 3,
    });
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" }, take: 3 });
    return {
      text: "Here are options that fit. Rate, tenor and minimum are shown together. Money moves only after you continue securely.",
      blocks: [
        {
          kind: "products",
          products: [
            ...bands
              .filter((b) => b.code !== "CALL")
              .slice(0, 2)
              .map((b) => ({
                name: b.label,
                rate: `${b.rateBps / 100}% p.a.`,
                tenor: b.maxDays ? `${b.minDays}-${b.maxDays} days` : `${b.minDays}+ days`,
                minimum: 10000,
                to: "/fixed-plans/create",
              })),
            ...products.map((p) => ({
              name: p.name,
              rate: `${p.rateBps / 100}% p.a.`,
              tenor: `${p.tenorDays} days`,
              minimum: koboToNaira(p.minimumKobo),
              to: `/explore/${p.id}/subscribe`,
            })),
          ],
        },
        { kind: "handoff", label: "Continue Securely", to: "/invest" },
      ],
    };
  }

  if (/(track|transaction|status|deposit)/.test(text)) {
    return {
      text: "Here is where to track recent money movements.",
      blocks: [{ kind: "handoff", label: "View transactions", to: "/portfolio/transactions" }],
    };
  }

  return {
    text: "I can help with your Kipit account, investments, transactions and available products. I never move money in chat — you confirm with your PIN on the secure screen.",
    blocks: [
      { kind: "chips", options: ["What's my balance?", "Help me invest", "Track a transaction"] },
    ],
  };
}
