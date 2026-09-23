import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import { ensureUserCall, ensureUserWallet, getWalletBalanceKobo } from "../services/money.js";

export const portfolioRouter = Router();

portfolioRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const wallet = await ensureUserWallet(req.userId!);
    const call = await ensureUserCall(req.userId!);
    const placements = await prisma.placement.findMany({
      where: { userId: req.userId!, status: "ACTIVE" },
    });

    const fixed = placements.filter((p) => p.kind === "FIXED");
    const explore = placements.filter((p) => p.kind === "EXPLORE");
    const fixedTotal = fixed.reduce((s, p) => s + p.principalKobo, 0n);
    const exploreTotal = explore.reduce((s, p) => s + p.principalKobo, 0n);
    const total = wallet.balanceKobo + call.balanceKobo + fixedTotal + exploreTotal;

    res.json({
      data: {
        total: koboToNaira(total),
        allocation: {
          wallet: koboToNaira(wallet.balanceKobo),
          call: koboToNaira(call.balanceKobo),
          fixed: koboToNaira(fixedTotal),
          explore: koboToNaira(exploreTotal),
        },
        holdings: placements.map((p) => ({
          id: p.id,
          kind: p.kind,
          name: p.name,
          principal: koboToNaira(p.principalKobo),
          ratePct: p.rateBps / 100,
          tenorDays: p.tenorDays,
          maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
          accrued: koboToNaira(p.accruedKobo),
          status: p.status,
        })),
      },
    });
  }),
);

portfolioRouter.get(
  "/holdings/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const p = await prisma.placement.findFirst({
      where: { id: String(req.params.id), userId: req.userId! },
      include: { product: true },
    });
    if (!p) throw new AppError(404, "Holding not found", "NOT_FOUND");
    res.json({
      data: {
        id: p.id,
        kind: p.kind,
        name: p.name,
        principal: koboToNaira(p.principalKobo),
        ratePct: p.rateBps / 100,
        tenorDays: p.tenorDays,
        startDate: p.startDate.toISOString().slice(0, 10),
        maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
        accrued: koboToNaira(p.accruedKobo),
        status: p.status,
        maturityInstruction: p.maturityInstruction,
        product: p.product
          ? { id: p.product.id, name: p.product.name, slug: p.product.slug }
          : null,
      },
    });
  }),
);

portfolioRouter.patch(
  "/holdings/:id/maturity",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        maturityInstruction: z.enum(["WALLET", "ROLLOVER", "PAYOUT"]),
      })
      .parse(req.body);
    const existing = await prisma.placement.findFirst({
      where: { id: String(req.params.id), userId: req.userId!, status: "ACTIVE" },
    });
    if (!existing) throw new AppError(404, "Holding not found", "NOT_FOUND");
    if (existing.maturityDate) {
      const hoursLeft =
        (existing.maturityDate.getTime() - Date.now()) / (60 * 60 * 1000);
      if (hoursLeft < 24) {
        throw new AppError(
          400,
          "Maturity instruction can only be changed up to 24 hours before maturity.",
          "MATURITY_LOCKED",
        );
      }
    }
    const updated = await prisma.placement.update({
      where: { id: existing.id },
      data: { maturityInstruction: body.maturityInstruction },
    });
    res.json({
      data: {
        id: updated.id,
        maturityInstruction: updated.maturityInstruction,
      },
    });
  }),
);

portfolioRouter.get(
  "/maturities",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const items = await prisma.placement.findMany({
      where: { userId: req.userId!, status: "ACTIVE", maturityDate: { not: null } },
      orderBy: { maturityDate: "asc" },
    });
    res.json({
      data: items.map((p) => ({
        id: p.id,
        name: p.name,
        amount: koboToNaira(p.principalKobo),
        maturityDate: p.maturityDate!.toISOString().slice(0, 10),
        daysLeft: Math.max(
          0,
          Math.ceil((p.maturityDate!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        ),
      })),
    });
  }),
);

portfolioRouter.get(
  "/transactions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId: req.userId! },
      select: { id: true, type: true },
    });
    const ids = accounts.map((a) => a.id);
    if (!ids.length) {
      res.json({ data: [] });
      return;
    }

    const lines = await prisma.journalLine.findMany({
      where: { accountId: { in: ids } },
      include: {
        entry: true,
        account: { select: { type: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    // One row per journal entry; prefer wallet line, else call (for Call interest).
    const byEntry = new Map<string, (typeof lines)[number]>();
    for (const line of lines) {
      const prev = byEntry.get(line.entryId);
      if (
        !prev ||
        line.account.type === "USER_WALLET" ||
        (prev.account.type !== "USER_WALLET" && line.account.type === "USER_CALL")
      ) {
        byEntry.set(line.entryId, line);
      }
    }

    const rows = [...byEntry.values()]
      .sort((a, b) => b.entry.createdAt.getTime() - a.entry.createdAt.getTime())
      .slice(0, 100)
      .map((l) => {
        const abs =
          l.amountKobo < 0n ? -l.amountKobo : l.amountKobo;
        return {
          id: l.entry.id,
          reference: l.entry.reference,
          kind: l.entry.kind,
          description: l.entry.description ?? l.entry.kind,
          amount: koboToNaira(abs),
          // Positive ledger amount on a user asset account = money in.
          direction: l.amountKobo >= 0n ? ("credit" as const) : ("debit" as const),
          accountType: l.account.type,
          createdAt: l.entry.createdAt.toISOString(),
        };
      });

    res.json({ data: rows });
  }),
);

portfolioRouter.get(
  "/transactions/:reference",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const entry = await prisma.journalEntry.findUnique({
      where: { reference: String(req.params.reference) },
      include: { lines: true },
    });
    if (!entry) throw new AppError(404, "Transaction not found", "NOT_FOUND");
    res.json({
      data: {
        id: entry.id,
        reference: entry.reference,
        kind: entry.kind,
        description: entry.description,
        createdAt: entry.createdAt,
        metadata: entry.metadata,
      },
    });
  }),
);
