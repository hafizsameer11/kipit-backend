/**
 * Extended admin resources — users detail, ledger, support, products, feed, team.
 * Mounted alongside adminRouter under /v1/admin.
 */
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { hashSecret, koboToNaira } from "../lib/crypto.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";
import { writeAudit } from "../services/audit.js";
import { getKycStatus } from "../services/kyc.js";

type AdminRequest = Request & { adminId?: string; adminRole?: string };

async function requireAdmin(req: AdminRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const token = header.slice(7);
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      sub: string;
      sid?: string;
      typ?: string;
      role?: string;
    };
    if (payload.typ !== "admin") throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const admin = await prisma.adminUser.findFirst({
      where: { id: payload.sub, active: true },
    });
    if (!admin) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    if (payload.sid) {
      const session = await prisma.adminSession.findFirst({
        where: { id: payload.sid, adminId: admin.id, revokedAt: null },
      });
      if (!session) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    req.adminId = admin.id;
    req.adminRole = admin.role;
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, "Unauthorized", "UNAUTHORIZED"));
  }
}

async function userBalances(userId: string) {
  const wallet = await ensureUserWallet(userId);
  const call = await ensureUserCall(userId);
  const placements = await prisma.placement.findMany({
    where: { userId, status: "ACTIVE" },
  });
  let fixed = 0n;
  let explore = 0n;
  for (const p of placements) {
    if (p.kind === "EXPLORE") explore += p.principalKobo;
    else fixed += p.principalKobo;
  }
  return {
    wallet: koboToNaira(wallet.balanceKobo),
    call: koboToNaira(call.balanceKobo),
    fixed: koboToNaira(fixed),
    explore: koboToNaira(explore),
  };
}

function fmtRelative(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const adminResourcesRouter = Router();

adminResourcesRouter.get(
  "/users/:userId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: String(req.params.userId) } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    const balances = await userBalances(user.id);
    const session = await prisma.session.findFirst({
      where: { userId: user.id, revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
    });
    const kyc = await getKycStatus(user.id).catch(() => null);
    res.json({
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        middleName: user.middleName,
        surname: user.surname,
        name: `${user.firstName} ${user.surname}`,
        kycTier: user.kycTier,
        frozen: user.frozen,
        createdAt: user.createdAt,
        lastActiveAt: session?.lastActiveAt ?? user.updatedAt,
        lastActive: fmtRelative(session?.lastActiveAt ?? user.updatedAt),
        balances,
        kyc,
      },
    });
  }),
);

adminResourcesRouter.get(
  "/users/:userId/transactions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ data: [] });
      return;
    }
    const lines = await prisma.journalLine.findMany({
      where: { accountId: { in: accountIds } },
      include: { entry: true, account: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const seen = new Set<string>();
    const rows = [];
    for (const line of lines) {
      if (seen.has(line.entryId)) continue;
      seen.add(line.entryId);
      rows.push({
        id: line.entry.id,
        reference: line.entry.reference,
        kind: line.entry.kind,
        description: line.entry.description,
        amount: koboToNaira(line.amountKobo < 0n ? -line.amountKobo : line.amountKobo),
        direction: line.amountKobo < 0n ? "out" : "in",
        createdAt: line.entry.createdAt,
      });
    }
    res.json({ data: rows });
  }),
);

adminResourcesRouter.get(
  "/users/:userId/placements",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.placement.findMany({
      where: { userId: String(req.params.userId) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      data: rows.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        status: p.status,
        principal: koboToNaira(p.principalKobo),
        ratePct: p.rateBps / 100,
        maturityDate: p.maturityDate,
        createdAt: p.createdAt,
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/users/:userId/sessions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.session.findMany({
      where: { userId: String(req.params.userId) },
      orderBy: { lastActiveAt: "desc" },
      take: 50,
    });
    res.json({
      data: rows.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        lastActiveAt: s.lastActiveAt,
        revokedAt: s.revokedAt,
        createdAt: s.createdAt,
        current: !s.revokedAt,
      })),
    });
  }),
);

adminResourcesRouter.patch(
  "/users/:userId/frozen",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({ frozen: z.boolean(), reason: z.string().optional() })
      .parse(req.body);
    const user = await prisma.user.update({
      where: { id: String(req.params.userId) },
      data: { frozen: body.frozen },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: body.frozen ? "user.frozen" : "user.unfrozen",
      entityType: "User",
      entityId: user.id,
      after: { frozen: body.frozen, reason: body.reason },
    });
    res.json({
      data: {
        id: user.id,
        frozen: user.frozen,
        name: `${user.firstName} ${user.surname}`,
      },
    });
  }),
);

adminResourcesRouter.get(
  "/withdrawals/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const r = await prisma.withdrawalRequest.findUnique({
      where: { id: String(req.params.id) },
      include: { user: true, payoutBank: true },
    });
    if (!r) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    const balances = await userBalances(r.userId);
    res.json({
      data: {
        id: r.id,
        reference: r.reference,
        status: r.status,
        amount: koboToNaira(r.amountKobo),
        declineReason: r.declineReason,
        bank: r.payoutBank.bankName,
        accountName: r.payoutBank.accountName,
        accountNumber: r.payoutBank.accountNumber,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
        user: {
          id: r.userId,
          name: `${r.user.firstName} ${r.user.surname}`,
          email: r.user.email,
          phone: r.user.phone,
          kycTier: r.user.kycTier,
          createdAt: r.user.createdAt,
        },
        balances,
      },
    });
  }),
);

adminResourcesRouter.get(
  "/transactions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const entries = await prisma.journalEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        lines: { include: { account: { include: { user: true } } } },
      },
    });
    res.json({
      data: entries.map((e) => {
        const userLine = e.lines.find((l) => l.account.userId);
        const user = userLine?.account.user;
        const amountLine = e.lines.find((l) => l.amountKobo !== 0n) ?? e.lines[0];
        const amountKobo = amountLine ? (amountLine.amountKobo < 0n ? -amountLine.amountKobo : amountLine.amountKobo) : 0n;
        return {
          id: e.id,
          reference: e.reference,
          kind: e.kind,
          description: e.description,
          amount: koboToNaira(amountKobo),
          createdAt: e.createdAt,
          user: user
            ? { id: user.id, name: `${user.firstName} ${user.surname}`, email: user.email }
            : null,
        };
      }),
    });
  }),
);

adminResourcesRouter.get(
  "/transactions/:reference",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const key = String(req.params.reference);
    const entry =
      (await prisma.journalEntry.findUnique({
        where: { reference: key },
        include: { lines: { include: { account: { include: { user: true } } } } },
      })) ??
      (await prisma.journalEntry.findUnique({
        where: { id: key },
        include: { lines: { include: { account: { include: { user: true } } } } },
      }));
    if (!entry) throw new AppError(404, "Transaction not found", "NOT_FOUND");
    const userLine = entry.lines.find((l) => l.account.userId);
    const user = userLine?.account.user;
    res.json({
      data: {
        id: entry.id,
        reference: entry.reference,
        kind: entry.kind,
        description: entry.description,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        user: user
          ? { id: user.id, name: `${user.firstName} ${user.surname}`, email: user.email }
          : null,
        lines: entry.lines.map((l) => ({
          id: l.id,
          accountType: l.account.type,
          amount: koboToNaira(l.amountKobo),
        })),
      },
    });
  }),
);

adminResourcesRouter.get(
  "/rates/requests",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.rateChangeRequest.findMany({
      include: { band: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const adminIds = [
      ...new Set(
        rows.flatMap((r) => [r.makerAdminId, r.checkerAdminId].filter(Boolean) as string[]),
      ),
    ];
    const admins = await prisma.adminUser.findMany({ where: { id: { in: adminIds } } });
    const byId = Object.fromEntries(admins.map((a) => [a.id, a]));
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        bandId: r.bandId,
        band: r.band.label,
        code: r.band.code,
        currentBps: r.band.rateBps,
        proposedBps: r.proposedBps,
        currentRate: r.band.rateBps / 100,
        proposedRate: r.proposedBps / 100,
        effectiveFrom: r.effectiveFrom,
        reason: r.reason,
        status: r.status,
        submittedBy: byId[r.makerAdminId]?.name ?? r.makerAdminId,
        decidedBy: r.checkerAdminId ? byId[r.checkerAdminId]?.name ?? r.checkerAdminId : null,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/support/tickets",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.supportTicket.findMany({
      include: { user: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    res.json({
      data: rows.map((t) => ({
        id: t.id,
        category: t.category,
        subject: t.subject,
        body: t.body,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        user: {
          id: t.userId,
          name: `${t.user.firstName} ${t.user.surname}`,
          email: t.user.email,
        },
      })),
    });
  }),
);

adminResourcesRouter.patch(
  "/support/tickets/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
        adminNote: z.string().optional(),
      })
      .parse(req.body);
    const existing = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "Ticket not found", "NOT_FOUND");
    const row = await prisma.supportTicket.update({
      where: { id: existing.id },
      data: {
        status: body.status,
        body: body.adminNote
          ? `${existing.body}\n\n— Admin note —\n${body.adminNote}`
          : undefined,
      },
      include: { user: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "support.ticket.updated",
      entityType: "SupportTicket",
      entityId: row.id,
      after: { status: row.status },
    });
    res.json({
      data: {
        id: row.id,
        status: row.status,
        subject: row.subject,
        body: row.body,
        user: { id: row.userId, name: `${row.user.firstName} ${row.user.surname}` },
      },
    });
  }),
);

adminResourcesRouter.get(
  "/products",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.product.findMany({
      include: { category: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        blurb: p.blurb,
        description: p.description,
        ratePct: p.rateBps / 100,
        tenorDays: p.tenorDays,
        minimum: koboToNaira(p.minimumKobo),
        availability: p.availability,
        issuer: p.issuer,
        largeTicket: p.largeTicket,
        category: { id: p.categoryId, name: p.category.name },
        createdAt: p.createdAt,
      })),
    });
  }),
);

adminResourcesRouter.post(
  "/products",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        categoryId: z.string(),
        slug: z.string().min(2),
        name: z.string().min(2),
        blurb: z.string().min(2),
        description: z.string().optional(),
        rateBps: z.number().int().positive(),
        tenorDays: z.number().int().positive(),
        minimum: z.number().positive(),
        availability: z.enum(["OPEN", "CLOSING", "CLOSED", "COMING_SOON"]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
      })
      .parse(req.body);
    const row = await prisma.product.create({
      data: {
        categoryId: body.categoryId,
        slug: body.slug,
        name: body.name,
        blurb: body.blurb,
        description: body.description,
        rateBps: body.rateBps,
        tenorDays: body.tenorDays,
        minimumKobo: BigInt(Math.round(body.minimum * 100)),
        availability: body.availability,
        issuer: body.issuer,
        largeTicket: body.largeTicket ?? false,
      },
      include: { category: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "product.created",
      entityType: "Product",
      entityId: row.id,
    });
    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.patch(
  "/products/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        blurb: z.string().optional(),
        description: z.string().optional(),
        rateBps: z.number().int().positive().optional(),
        tenorDays: z.number().int().positive().optional(),
        minimum: z.number().positive().optional(),
        availability: z.enum(["OPEN", "CLOSING", "CLOSED", "COMING_SOON"]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
      })
      .parse(req.body);
    const row = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: {
        name: body.name,
        blurb: body.blurb,
        description: body.description,
        rateBps: body.rateBps,
        tenorDays: body.tenorDays,
        minimumKobo:
          body.minimum !== undefined ? BigInt(Math.round(body.minimum * 100)) : undefined,
        availability: body.availability,
        issuer: body.issuer,
        largeTicket: body.largeTicket,
      },
      include: { category: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "product.updated",
      entityType: "Product",
      entityId: row.id,
    });
    res.json({ data: row });
  }),
);

adminResourcesRouter.get(
  "/marketing/feed",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.feedCard.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({ data: rows });
  }),
);

adminResourcesRouter.post(
  "/marketing/feed",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        title: z.string().min(1),
        body: z.string().min(1),
        kind: z.string().min(1),
        href: z.string().optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const row = await prisma.feedCard.create({
      data: {
        title: body.title,
        body: body.body,
        kind: body.kind,
        href: body.href,
        active: body.active ?? true,
        sortOrder: body.sortOrder ?? 0,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "feed.created",
      entityType: "FeedCard",
      entityId: row.id,
    });
    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.patch(
  "/marketing/feed/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.string().optional(),
        href: z.string().nullable().optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const row = await prisma.feedCard.update({
      where: { id: String(req.params.id) },
      data: body,
    });
    res.json({ data: row });
  }),
);

adminResourcesRouter.get(
  "/team",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
    res.json({
      data: rows.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        role: a.role,
        active: a.active,
        createdAt: a.createdAt,
      })),
    });
  }),
);

adminResourcesRouter.post(
  "/team",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(2),
        role: z.enum(["SUPER", "GLOBAL", "COMPLIANCE", "OPERATIONS", "MARKETING"]),
        password: z.string().min(8),
      })
      .parse(req.body);
    const passwordHash = await hashSecret(body.password);
    const row = await prisma.adminUser.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name,
        role: body.role,
        passwordHash,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.created",
      entityType: "AdminUser",
      entityId: row.id,
    });
    res.status(201).json({
      data: { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active },
    });
  }),
);

adminResourcesRouter.patch(
  "/team/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        role: z.enum(["SUPER", "GLOBAL", "COMPLIANCE", "OPERATIONS", "MARKETING"]).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const row = await prisma.adminUser.update({
      where: { id: String(req.params.id) },
      data: body,
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.updated",
      entityType: "AdminUser",
      entityId: row.id,
      after: body,
    });
    res.json({
      data: { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active },
    });
  }),
);

adminResourcesRouter.get(
  "/chat/sessions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.chatSession.findMany({
      include: {
        user: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      data: rows.map((s) => ({
        id: s.id,
        user: { id: s.userId, name: `${s.user.firstName} ${s.user.surname}`, email: s.user.email },
        createdAt: s.createdAt,
        lastMessage: s.messages[0]?.content ?? null,
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/chat/sessions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const s = await prisma.chatSession.findUnique({
      where: { id: String(req.params.id) },
      include: {
        user: true,
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!s) throw new AppError(404, "Session not found", "NOT_FOUND");
    res.json({
      data: {
        id: s.id,
        user: { id: s.userId, name: `${s.user.firstName} ${s.user.surname}`, email: s.user.email },
        createdAt: s.createdAt,
        messages: s.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          blocks: m.blocks,
          createdAt: m.createdAt,
        })),
      },
    });
  }),
);

/** Domains without dedicated tables yet — empty stubs. */
adminResourcesRouter.get(
  "/aml/alerts",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ data: [] });
  }),
);

adminResourcesRouter.get(
  "/recon",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ data: [] });
  }),
);

adminResourcesRouter.get(
  "/campaigns",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ data: [] });
  }),
);

adminResourcesRouter.get(
  "/adjustments",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ data: { requests: [], investments: [] } });
  }),
);

adminResourcesRouter.get(
  "/notifications",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    res.json({
      data: rows.map((r) => {
        const created = r.createdAt;
        let day: "Today" | "Yesterday" | "Earlier" = "Earlier";
        if (created >= startOfToday) day = "Today";
        else if (created >= startOfYesterday) day = "Yesterday";
        const action = r.action.toLowerCase();
        let kind = "system";
        if (action.includes("kyc") || action.includes("compliance") || action.includes("frozen")) {
          kind = "compliance";
        } else if (action.includes("withdraw")) kind = "withdrawal";
        else if (action.includes("rate")) kind = "rates";
        else if (action.includes("support") || action.includes("ticket")) kind = "support";
        else if (action.includes("recon")) kind = "reconciliation";
        return {
          id: r.id,
          kind,
          title: r.action,
          body: [r.entityType, r.entityId].filter(Boolean).join(" · ") || "Audit event",
          time: created.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
          day,
          unread: created >= startOfToday,
          priority: action.includes("frozen") || action.includes("decline") ? "high" : "normal",
          to: undefined as string | undefined,
          createdAt: created,
        };
      }),
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/maturities",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const in7 = new Date(now);
    in7.setDate(in7.getDate() + 7);
    const in30 = new Date(now);
    in30.setDate(in30.getDate() + 30);
    const rows = await prisma.placement.findMany({
      where: {
        status: "ACTIVE",
        maturityDate: { gte: now, lte: in30 },
      },
      include: { user: true },
      orderBy: { maturityDate: "asc" },
      take: 100,
    });
    res.json({
      data: rows.map((p) => {
        const maturity = p.maturityDate ?? now;
        const window = maturity <= in7 ? "week" : "month";
        const interest =
          (p.principalKobo * BigInt(p.rateBps) * BigInt(p.tenorDays ?? 0)) / 365n / 10000n;
        const expected = p.principalKobo + interest;
        return {
          id: p.id,
          user: `${p.user.firstName} ${p.user.surname}`,
          product: p.name,
          principal: koboToNaira(p.principalKobo),
          expected: koboToNaira(expected),
          date: maturity.toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }),
          window,
          maturityDate: maturity,
        };
      }),
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/activity",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const adminIds = [...new Set(rows.map((r) => r.actorAdminId).filter(Boolean) as string[])];
    const admins = adminIds.length
      ? await prisma.adminUser.findMany({ where: { id: { in: adminIds } } })
      : [];
    const byId = Object.fromEntries(admins.map((a) => [a.id, a]));
    res.json({
      data: rows.map((r) => {
        const action = r.action.toLowerCase();
        let kind: "kyc" | "payout" | "rate" | "content" | "decline" = "content";
        if (action.includes("kyc")) kind = "kyc";
        else if (action.includes("decline")) kind = "decline";
        else if (action.includes("withdraw") || action.includes("payout")) kind = "payout";
        else if (action.includes("rate")) kind = "rate";
        const who = r.actorAdminId
          ? byId[r.actorAdminId]?.name?.split(" ")[0] ?? "Admin"
          : "System";
        return {
          id: r.id,
          kind,
          team: kind === "kyc" ? "Compliance" : kind === "rate" ? "Global Admin" : "Operations",
          who,
          action: r.action,
          detail: [r.entityType, r.entityId].filter(Boolean).join(" · ") || "—",
          at: fmtRelative(r.createdAt),
          createdAt: r.createdAt,
        };
      }),
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/today-flows",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const entries = await prisma.journalEntry.findMany({
      where: { createdAt: { gte: start } },
      include: { lines: true },
    });
    let deposits = 0n;
    let placements = 0n;
    let interestCredits = 0n;
    let withdrawals = 0n;
    for (const e of entries) {
      const abs = e.lines.reduce((s, l) => {
        const a = l.amountKobo < 0n ? -l.amountKobo : l.amountKobo;
        return a > s ? a : s;
      }, 0n);
      if (e.kind === "DEPOSIT" || e.kind === "CALL_DEPOSIT") deposits += abs;
      else if (e.kind === "PLACEMENT") placements += abs;
      else if (e.kind === "INTEREST") interestCredits += abs;
      else if (e.kind === "WITHDRAWAL" || e.kind === "CALL_WITHDRAW") withdrawals += abs;
    }
    res.json({
      data: {
        deposits: koboToNaira(deposits),
        placements: koboToNaira(placements),
        interestCredits: koboToNaira(interestCredits),
        withdrawals: koboToNaira(withdrawals),
      },
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/principal-by-tenor",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.placement.findMany({
      where: { status: "ACTIVE", kind: "FIXED" },
      select: { principalKobo: true, tenorDays: true, rateBps: true },
    });
    const buckets: Record<string, { value: bigint; rateBps: number; count: number }> = {
      "30 days": { value: 0n, rateBps: 0, count: 0 },
      "90 days": { value: 0n, rateBps: 0, count: 0 },
      "180 days": { value: 0n, rateBps: 0, count: 0 },
      "365 days": { value: 0n, rateBps: 0, count: 0 },
    };
    for (const p of rows) {
      const d = p.tenorDays ?? 0;
      const band =
        d <= 30 ? "30 days" : d <= 90 ? "90 days" : d <= 180 ? "180 days" : "365 days";
      const b = buckets[band]!;
      b.value += p.principalKobo;
      b.rateBps += p.rateBps;
      b.count += 1;
    }
    res.json({
      data: Object.entries(buckets).map(([band, b]) => ({
        band,
        value: koboToNaira(b.value),
        rate: b.count ? `${(b.rateBps / b.count / 100).toFixed(1)}%` : "—",
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/principal-by-product",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.placement.findMany({
      where: { status: "ACTIVE", kind: "EXPLORE" },
      select: { name: true, principalKobo: true },
    });
    const byName = new Map<string, bigint>();
    for (const p of rows) {
      byName.set(p.name, (byName.get(p.name) ?? 0n) + p.principalKobo);
    }
    res.json({
      data: [...byName.entries()]
        .map(([product, value]) => ({ product, value: koboToNaira(value) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8),
    });
  }),
);
