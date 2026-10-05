/**
 * Extended admin resources — users detail, ledger, support, products, feed, team.
 * Mounted alongside adminRouter under /v1/admin.
 */
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { asyncHandler, AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { hashSecret, koboToNaira, nairaToKobo } from "../lib/crypto.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";
import { writeAudit } from "../services/audit.js";
import { getKycStatus } from "../services/kyc.js";
import { createUserNotification, notifyAccountAccessChange } from "../services/notify.js";
import { saveProductDocument, saveSupportAttachment } from "../services/uploads.js";
import {
  getConfigJson,
  setConfigJson,
  type StoredAdjustment,
  type StoredAmlAlert,
  type StoredCampaign,
  type StoredReconRecord,
} from "../services/admin-ops-store.js";
import {
  classifyChatSessionOutcome,
  handoffDestinationLabel,
  isSupportHandoffPath,
} from "../services/chat-outcome.js";
import { nanoid } from "nanoid";

type AdminRequest = Request & { adminId?: string; adminRole?: string; adminName?: string };

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
    req.adminName = admin.name;
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
    const reason = body.reason?.trim() || null;
    const user = await prisma.user.update({
      where: { id: String(req.params.userId) },
      data: {
        frozen: body.frozen,
        frozenReason: body.frozen ? reason : null,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: body.frozen ? "user.frozen" : "user.unfrozen",
      entityType: "User",
      entityId: user.id,
      after: { frozen: body.frozen, reason },
    });
    await notifyAccountAccessChange({
      userId: user.id,
      frozen: body.frozen,
      reason: reason ?? undefined,
    }).catch((err) => console.warn("[admin] freeze notify failed", err));
    res.json({
      data: {
        id: user.id,
        frozen: user.frozen,
        frozenReason: user.frozenReason,
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
        currentBps: r.previousBps ?? r.band.rateBps,
        proposedBps: r.proposedBps,
        currentRate: (r.previousBps ?? r.band.rateBps) / 100,
        proposedRate: r.proposedBps / 100,
        effectiveFrom: r.effectiveFrom,
        reason: r.reason,
        status: r.status,
        appliedAt: r.appliedAt,
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
      include: {
        user: true,
        assigneeAdmin: { select: { id: true, name: true, email: true } },
        messages: { orderBy: { createdAt: "asc" }, take: 50 },
      },
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
        priority: t.priority || "normal",
        attachmentUrl: t.attachmentUrl,
        attachmentName: t.attachmentName,
        assigneeAdminId: t.assigneeAdminId,
        assignee: t.assigneeAdmin
          ? { id: t.assigneeAdmin.id, name: t.assigneeAdmin.name, email: t.assigneeAdmin.email }
          : null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messages: t.messages.map((m) => ({
          id: m.id,
          author: m.author,
          body: m.body,
          attachmentUrl: m.attachmentUrl,
          attachmentName: m.attachmentName,
          createdAt: m.createdAt,
        })),
        user: {
          id: t.userId,
          name: `${t.user.firstName} ${t.user.surname}`,
          email: t.user.email,
        },
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/support/tickets/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await prisma.supportTicket.findUnique({
      where: { id: String(req.params.id) },
      include: {
        user: true,
        assigneeAdmin: { select: { id: true, name: true, email: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!row) throw new AppError(404, "Ticket not found", "NOT_FOUND");
    const messages =
      row.messages.length > 0
        ? row.messages
        : [
            {
              id: `legacy-${row.id}`,
              author: "USER" as const,
              body: row.body,
              attachmentUrl: row.attachmentUrl,
              attachmentName: row.attachmentName,
              createdAt: row.createdAt,
            },
          ];
    res.json({
      data: {
        id: row.id,
        category: row.category,
        subject: row.subject,
        body: row.body,
        status: row.status,
        priority: row.priority || "normal",
        attachmentUrl: row.attachmentUrl,
        attachmentName: row.attachmentName,
        assigneeAdminId: row.assigneeAdminId,
        assignee: row.assigneeAdmin
          ? { id: row.assigneeAdmin.id, name: row.assigneeAdmin.name, email: row.assigneeAdmin.email }
          : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messages: messages.map((m) => ({
          id: m.id,
          author: m.author,
          body: m.body,
          attachmentUrl: m.attachmentUrl,
          attachmentName: m.attachmentName,
          createdAt: m.createdAt,
        })),
        user: {
          id: row.userId,
          name: `${row.user.firstName} ${row.user.surname}`,
          email: row.user.email,
        },
      },
    });
  }),
);

adminResourcesRouter.post(
  "/support/tickets/:id/attachments",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!ticket) throw new AppError(404, "Ticket not found", "NOT_FOUND");
    const body = z
      .object({
        contentType: z.string().min(3).max(100),
        dataBase64: z.string().min(32),
        filename: z.string().min(1).max(160).optional(),
      })
      .parse(req.body);
    const saved = await saveSupportAttachment({
      userId: ticket.userId,
      contentType: body.contentType,
      dataBase64: body.dataBase64,
      originalName: body.filename,
    });
    res.status(201).json({
      data: {
        url: saved.url,
        path: saved.relativePath,
        bytes: saved.bytes,
        filename: saved.filename,
      },
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
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        adminNote: z.string().optional(),
        reply: z.string().min(1).max(4000).optional(),
        attachmentUrl: z.string().min(8).max(500).optional(),
        attachmentName: z.string().min(1).max(160).optional(),
      })
      .parse(req.body);
    const existing = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "Ticket not found", "NOT_FOUND");

    const replyText = (body.reply ?? body.adminNote)?.trim();
    const attachmentUrl = body.attachmentUrl?.trim();
    const attachmentName = body.attachmentName?.trim() || undefined;
    if (attachmentUrl && !attachmentUrl.includes(`/uploads/support/${existing.userId}/`)) {
      throw new AppError(400, "Invalid attachment. Upload the file again.", "UPLOAD_INVALID");
    }
    if (!replyText && !attachmentUrl) {
      // status-only update allowed
    } else if (!replyText && attachmentUrl) {
      throw new AppError(400, "Add a short reply with the attachment.", "REPLY_REQUIRED");
    }

    if (replyText) {
      const count = await prisma.supportTicketMessage.count({ where: { ticketId: existing.id } });
      if (count === 0) {
        await prisma.supportTicketMessage.create({
          data: {
            ticketId: existing.id,
            author: "USER",
            body: existing.body,
            attachmentUrl: existing.attachmentUrl,
            attachmentName: existing.attachmentName,
            createdAt: existing.createdAt,
          },
        });
      }
      await prisma.supportTicketMessage.create({
        data: {
          ticketId: existing.id,
          author: "SUPPORT",
          body: replyText,
          attachmentUrl: attachmentUrl ?? null,
          attachmentName: attachmentName ?? null,
        },
      });
      await createUserNotification({
        userId: existing.userId,
        title: "Support replied",
        body: `New reply on “${existing.subject}”.`,
        href: `/settings/help/tickets/${existing.id}`,
        pushKind: "security",
      }).catch(() => undefined);
    }

    const row = await prisma.supportTicket.update({
      where: { id: existing.id },
      data: {
        status: body.status ?? (replyText ? "IN_PROGRESS" : undefined),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      },
      include: { user: true, messages: { orderBy: { createdAt: "asc" } } },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "support.ticket.updated",
      entityType: "SupportTicket",
      entityId: row.id,
      after: { status: row.status, priority: row.priority, replied: Boolean(replyText) },
    });
    res.json({
      data: {
        id: row.id,
        status: row.status,
        priority: row.priority,
        subject: row.subject,
        body: row.body,
        attachmentUrl: row.attachmentUrl,
        attachmentName: row.attachmentName,
        messages: row.messages.map((m) => ({
          id: m.id,
          author: m.author,
          body: m.body,
          attachmentUrl: m.attachmentUrl,
          attachmentName: m.attachmentName,
          createdAt: m.createdAt,
        })),
        user: { id: row.userId, name: `${row.user.firstName} ${row.user.surname}` },
      },
    });
  }),
);

adminResourcesRouter.post(
  "/products/attachments",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const { assertAdminPermission } = await import("../services/admin-permissions.js");
    await assertAdminPermission(req.adminRole, "product.manage");
    const body = z
      .object({
        contentType: z.string().min(3).max(100),
        dataBase64: z.string().min(32),
        filename: z.string().min(1).max(160).optional(),
      })
      .parse(req.body);
    const saved = await saveProductDocument({
      adminId: req.adminId || "library",
      contentType: body.contentType,
      dataBase64: body.dataBase64,
      originalName: body.filename,
    });
    res.status(201).json({
      data: {
        url: saved.url,
        path: saved.relativePath,
        bytes: saved.bytes,
        filename: saved.filename,
      },
    });
  }),
);

adminResourcesRouter.get(
  "/products/categories",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.productCategory.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({
      data: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
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
    const { assertAdminPermission } = await import("../services/admin-permissions.js");
    await assertAdminPermission(req.adminRole, "product.manage");
    const body = z
      .object({
        categoryId: z.string().optional(),
        categoryName: z.string().optional(),
        slug: z.string().min(2).optional(),
        name: z.string().min(2),
        blurb: z.string().min(2).optional(),
        description: z.string().optional(),
        rateBps: z.number().int().positive().optional(),
        ratePct: z.number().positive().optional(),
        tenorDays: z.number().int().positive(),
        minimum: z.number().positive(),
        availability: z.enum(["OPEN", "CLOSING", "CLOSED", "COMING_SOON"]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
        details: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    let categoryId = body.categoryId;
    if (!categoryId) {
      const name = body.categoryName?.trim() || "Fixed Income";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const cat = await prisma.productCategory.upsert({
        where: { slug },
        create: { slug, name, sortOrder: 99 },
        update: {},
      });
      categoryId = cat.id;
    }

    const rateBps =
      body.rateBps ??
      (body.ratePct != null ? Math.round(body.ratePct * 100) : undefined);
    if (rateBps == null) throw new AppError(400, "rateBps or ratePct required", "RATE_REQUIRED");

    const slug =
      body.slug?.trim() ||
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) +
        `-${Date.now().toString(36).slice(-4)}`;

    const row = await prisma.product.create({
      data: {
        categoryId,
        slug,
        name: body.name,
        blurb: body.blurb ?? body.name,
        description: body.description,
        rateBps,
        tenorDays: body.tenorDays,
        minimumKobo: BigInt(Math.round(body.minimum * 100)),
        availability: body.availability ?? "OPEN",
        issuer: body.issuer,
        largeTicket: body.largeTicket ?? false,
        details: (body.details as Prisma.InputJsonValue | undefined) ?? undefined,
      },
      include: { category: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "product.created",
      entityType: "Product",
      entityId: row.id,
      after: { name: row.name, availability: row.availability },
    });
    res.status(201).json({
      data: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        ratePct: row.rateBps / 100,
        tenorDays: row.tenorDays,
        minimum: koboToNaira(row.minimumKobo),
        availability: row.availability,
        details: row.details,
      },
    });
  }),
);

adminResourcesRouter.patch(
  "/products/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const { assertAdminPermission } = await import("../services/admin-permissions.js");
    await assertAdminPermission(req.adminRole, "product.manage");
    const body = z
      .object({
        name: z.string().optional(),
        blurb: z.string().optional(),
        description: z.string().optional(),
        rateBps: z.number().int().positive().optional(),
        ratePct: z.number().positive().optional(),
        tenorDays: z.number().int().positive().optional(),
        minimum: z.number().positive().optional(),
        availability: z.enum(["OPEN", "CLOSING", "CLOSED", "COMING_SOON"]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
        details: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    const rateBps =
      body.rateBps ?? (body.ratePct != null ? Math.round(body.ratePct * 100) : undefined);
    const row = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: {
        name: body.name,
        blurb: body.blurb,
        description: body.description,
        rateBps,
        tenorDays: body.tenorDays,
        minimumKobo:
          body.minimum !== undefined ? BigInt(Math.round(body.minimum * 100)) : undefined,
        availability: body.availability,
        issuer: body.issuer,
        largeTicket: body.largeTicket,
        details: body.details as Prisma.InputJsonValue | undefined,
      },
      include: { category: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "product.updated",
      entityType: "Product",
      entityId: row.id,
      after: { name: row.name, availability: row.availability },
    });
    res.json({
      data: {
        id: row.id,
        name: row.name,
        ratePct: row.rateBps / 100,
        tenorDays: row.tenorDays,
        minimum: koboToNaira(row.minimumKobo),
        availability: row.availability,
        details: row.details,
      },
    });
  }),
);

adminResourcesRouter.get(
  "/marketing/feed",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const { backfillFeedImpressions } = await import("../services/feed-impressions.js");
    await backfillFeedImpressions();
    const rows = await prisma.feedCard.findMany({
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { views: true } } },
    });
    res.json({
      data: rows.map(({ _count, ...row }) => ({
        ...row,
        impressions: _count.views,
      })),
    });
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
        role: z.enum([
          "SUPER",
          "GLOBAL",
          "COMPLIANCE",
          "OPERATIONS",
          "MARKETING",
          "FINANCE",
          "SUPPORT",
          "READ_ONLY",
        ]),
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
        role: z
          .enum([
            "SUPER",
            "GLOBAL",
            "COMPLIANCE",
            "OPERATIONS",
            "MARKETING",
            "FINANCE",
            "SUPPORT",
            "READ_ONLY",
          ])
          .optional(),
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
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, blocks: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({
      data: rows.map((s) => {
        const firstUser = s.messages.find((m) => m.role === "user")?.content ?? null;
        const last = s.messages[s.messages.length - 1]?.content ?? null;
        const classified = classifyChatSessionOutcome({
          messageCount: s._count.messages,
          flagged: s.flagged,
          messages: s.messages,
        });
        return {
          id: s.id,
          user: {
            id: s.userId,
            name: `${s.user.firstName} ${s.user.surname}`,
            email: s.user.email,
          },
          createdAt: s.createdAt,
          messageCount: s._count.messages,
          firstUserMessage: firstUser,
          lastMessage: last,
          flagged: s.flagged || classified.outcome === "escalated",
          outcome: classified.outcome,
          handoffTo: classified.handoffTo,
        };
      }),
    });
  }),
);

adminResourcesRouter.patch(
  "/chat/sessions/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z.object({ flagged: z.boolean() }).parse(req.body);
    const row = await prisma.chatSession.update({
      where: { id: String(req.params.id) },
      data: { flagged: body.flagged },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: body.flagged ? "chat.flagged" : "chat.unflagged",
      entityType: "ChatSession",
      entityId: row.id,
    });
    res.json({ data: { id: row.id, flagged: row.flagged } });
  }),
);

adminResourcesRouter.get(
  "/chat/analytics",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const start30 = new Date(now);
    start30.setDate(start30.getDate() - 30);
    start30.setHours(0, 0, 0, 0);
    const start14 = new Date(now);
    start14.setDate(start14.getDate() - 13);
    start14.setHours(0, 0, 0, 0);
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);

    const sessions = await prisma.chatSession.findMany({
      where: { createdAt: { gte: start30 } },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, blocks: true, createdAt: true },
        },
        user: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const classifyIntent = (text: string): string => {
      const t = text.toLowerCase();
      if (/balance|portfolio|how much|wallet|holdings/.test(t)) return "balance";
      if (/rate|product|fixed|explore|invest|90 day|call account/.test(t)) return "product";
      if (/what is|explain|how does|mean/.test(t)) return "explain";
      if (/matur|payout|when does/.test(t)) return "maturity";
      if (/withdraw|transaction|transfer|status|where is/.test(t)) return "transaction";
      if (/add money|fund|deposit|virtual account|card/.test(t)) return "funding";
      return "unsupported";
    };

    const intentCounts: Record<string, number> = {};
    const questionCounts = new Map<string, { asked: number; resolved: number }>();
    const handoffCounts = new Map<string, number>();
    const volumeMap = new Map<string, { resolved: number; handoff: number; abandoned: number; escalated: number }>();
    let messages30d = 0;
    let flagged = 0;
    let turnSum = 0;
    const users = new Set<string>();

    for (const s of sessions) {
      users.add(s.userId);
      messages30d += s.messages.length;
      turnSum += s.messages.length;
      const firstUser = s.messages.find((m) => m.role === "user")?.content ?? "";
      const intent = classifyIntent(firstUser);
      intentCounts[intent] = (intentCounts[intent] ?? 0) + 1;
      const classified = classifyChatSessionOutcome({
        messageCount: s.messages.length,
        flagged: s.flagged,
        messages: s.messages,
      });
      const outcome = classified.outcome;
      if (s.flagged || outcome === "escalated") flagged += 1;
      if (outcome === "handoff") {
        const journey =
          classified.handoffs.find((h) => !isSupportHandoffPath(h.to)) ?? classified.handoffs[0];
        const label = journey
          ? handoffDestinationLabel(journey.to, journey.label)
          : classified.handoffTo || "Secure journey";
        handoffCounts.set(label, (handoffCounts.get(label) ?? 0) + 1);
      }
      if (firstUser.trim()) {
        const key = firstUser.trim().slice(0, 80);
        const prev = questionCounts.get(key) ?? { asked: 0, resolved: 0 };
        prev.asked += 1;
        if (outcome === "resolved") prev.resolved += 1;
        questionCounts.set(key, prev);
      }

      const dayKey = s.createdAt.toISOString().slice(0, 10);
      if (s.createdAt >= start14) {
        const bucket = volumeMap.get(dayKey) ?? {
          resolved: 0,
          handoff: 0,
          abandoned: 0,
          escalated: 0,
        };
        if (outcome === "resolved") bucket.resolved += 1;
        else if (outcome === "handoff") bucket.handoff += 1;
        else if (outcome === "escalated") bucket.escalated += 1;
        else bucket.abandoned += 1;
        volumeMap.set(dayKey, bucket);
      }
    }

    const sessionsToday = sessions.filter((s) => s.createdAt >= startToday).length;
    const resolved = sessions.filter(
      (s) =>
        classifyChatSessionOutcome({
          messageCount: s.messages.length,
          flagged: s.flagged,
          messages: s.messages,
        }).outcome === "resolved",
    ).length;
    const handoffs = sessions.filter(
      (s) =>
        classifyChatSessionOutcome({
          messageCount: s.messages.length,
          flagged: s.flagged,
          messages: s.messages,
        }).outcome === "handoff",
    ).length;
    const containmentPct = sessions.length
      ? Math.round((resolved / sessions.length) * 100)
      : 0;
    const handoffPct = sessions.length ? Math.round((handoffs / sessions.length) * 100) : 0;

    const volume: { day: string; resolved: number; handoff: number; abandoned: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start14);
      d.setDate(start14.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const bucket = volumeMap.get(key) ?? { resolved: 0, handoff: 0, abandoned: 0, escalated: 0 };
      volume.push({
        day: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        resolved: bucket.resolved,
        handoff: bucket.handoff + bucket.escalated,
        abandoned: bucket.abandoned,
      });
    }

    const intentOrder = [
      "balance",
      "product",
      "explain",
      "maturity",
      "transaction",
      "funding",
      "unsupported",
    ];

    res.json({
      data: {
        sessions30d: sessions.length,
        sessionsToday,
        activeUsers30d: users.size,
        messages30d,
        avgTurns: sessions.length ? (turnSum / sessions.length).toFixed(1) : "0",
        containment: `${containmentPct}%`,
        handoffRate: `${handoffPct}%`,
        flagged,
        avgResponse: "—",
        volume,
        intentMix: intentOrder.map((intent) => ({
          intent,
          sessions: intentCounts[intent] ?? 0,
        })),
        topQuestions: [...questionCounts.entries()]
          .sort((a, b) => b[1].asked - a[1].asked)
          .slice(0, 8)
          .map(([text, v]) => ({
            text,
            asked: v.asked,
            resolvedPct: v.asked ? Math.round((v.resolved / v.asked) * 100) : 0,
          })),
        handoffs: [...handoffCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => ({ label, count })),
      },
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
    const classified = classifyChatSessionOutcome({
      messageCount: s.messages.length,
      flagged: s.flagged,
      messages: s.messages,
    });
    res.json({
      data: {
        id: s.id,
        user: { id: s.userId, name: `${s.user.firstName} ${s.user.surname}`, email: s.user.email },
        createdAt: s.createdAt,
        flagged: s.flagged || classified.outcome === "escalated",
        outcome: classified.outcome,
        handoffTo: classified.handoffTo,
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

/** Ops stores for domains without dedicated tables — persisted in AppConfig. */
adminResourcesRouter.get(
  "/aml/alerts",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const alerts = await getConfigJson<StoredAmlAlert[]>("admin.aml.alerts", []);
    res.json({
      data: alerts.map((a) => ({
        id: a.id,
        userId: a.userId ?? "unknown",
        name: a.customerName,
        type: a.rule,
        status:
          a.status === "cleared"
            ? "cleared"
            : a.status === "str_filed"
              ? "reported"
              : a.status === "escalated"
                ? "investigating"
                : "open",
        raised: a.createdAt,
        score: a.severity === "high" ? 92 : a.severity === "medium" ? 71 : 48,
        summary: a.rule,
        matchedAgainst: a.rule,
        analyst: a.assignee ?? "Unassigned",
        notes: a.notes.map((n) => ({ at: n.at, actor: n.author, text: n.body })),
      })),
    });
  }),
);

adminResourcesRouter.post(
  "/aml/alerts",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        customerName: z.string().min(1),
        email: z.string().optional(),
        userId: z.string().optional(),
        rule: z.string().min(1),
        severity: z.enum(["low", "medium", "high"]).default("medium"),
        amount: z.number().optional(),
      })
      .parse(req.body);
    const alerts = await getConfigJson<StoredAmlAlert[]>("admin.aml.alerts", []);
    const now = new Date().toISOString();
    const row: StoredAmlAlert = {
      id: `aml_${nanoid(10)}`,
      userId: body.userId,
      customerName: body.customerName,
      email: body.email,
      rule: body.rule,
      severity: body.severity,
      status: "open",
      amount: body.amount,
      notes: [],
      assignee: null,
      createdAt: now,
      updatedAt: now,
    };
    alerts.unshift(row);
    await setConfigJson("admin.aml.alerts", alerts, req.adminId);
    const { sendAmlEscalationAlert } = await import("../services/admin-alerts.js");
    await sendAmlEscalationAlert({
      alertId: row.id,
      customerName: row.customerName,
      rule: row.rule,
      severity: row.severity,
      status: row.status,
      assignee: row.assignee,
      amount: row.amount,
    }).catch((err) => console.warn("[aml] create alert email failed", err));
    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.patch(
  "/aml/alerts/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        status: z.enum(["open", "cleared", "escalated", "str_filed"]).optional(),
        note: z.string().optional(),
        assignee: z.string().nullable().optional(),
      })
      .parse(req.body);
    const alerts = await getConfigJson<StoredAmlAlert[]>("admin.aml.alerts", []);
    const idx = alerts.findIndex((a) => a.id === String(req.params.id));
    if (idx < 0) throw new AppError(404, "Alert not found", "NOT_FOUND");
    const row = alerts[idx]!;
    if (body.status) row.status = body.status;
    if (body.assignee !== undefined) row.assignee = body.assignee;
    if (body.note?.trim()) {
      row.notes.push({
        at: new Date().toISOString(),
        author: req.adminName || "Admin",
        body: body.note.trim(),
      });
    }
    row.updatedAt = new Date().toISOString();
    alerts[idx] = row;
    await setConfigJson("admin.aml.alerts", alerts, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "aml.alert.updated",
      entityType: "AmlAlert",
      entityId: row.id,
      after: body,
    });
    const shouldNotify =
      body.status === "escalated" ||
      (body.assignee !== undefined && Boolean(body.assignee?.trim()));
    if (shouldNotify) {
      const { sendAmlEscalationAlert } = await import("../services/admin-alerts.js");
      await sendAmlEscalationAlert({
        alertId: row.id,
        customerName: row.customerName,
        rule: row.rule,
        severity: row.severity,
        status: row.status,
        assignee: row.assignee,
        amount: row.amount,
      }).catch((err) => console.warn("[aml] escalate alert email failed", err));
    }
    res.json({ data: row });
  }),
);

adminResourcesRouter.get(
  "/recon",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    // Keep dashboard fresh when ops open the page.
    try {
      const { runWalletReconJobThrottled } = await import("../jobs/wallet-recon.js");
      await runWalletReconJobThrottled();
    } catch (err) {
      console.warn("[recon] scan failed", err);
    }

    const records = await getConfigJson<StoredReconRecord[]>("admin.recon.records", []);
    res.json({
      data: records.map((r) => {
        const providerAmount = r.providerAmount ?? (r.status === "open" ? Math.abs(r.variance) : 0);
        const ledgerAmount = r.ledgerAmount ?? 0;
        const uiStatus =
          r.status === "investigating" || r.status === "resolved"
            ? r.status
            : r.exception === "variance" ||
                (Math.abs(providerAmount - ledgerAmount) > 0.009 &&
                  providerAmount > 0 &&
                  ledgerAmount > 0)
              ? "variance"
              : "unmatched";
        return {
          id: r.id,
          providerRef: r.reference,
          internalRef: r.internalRef ?? r.id,
          source: r.source,
          customer: r.customerName,
          providerAmount,
          ledgerAmount,
          date: r.createdAt.slice(0, 10),
          status: uiStatus,
          channel: r.channel ?? r.source,
          note: r.notes.at(-1)?.body,
          owner: undefined,
          timeline: r.notes.map((n) => ({ label: n.body, at: n.at, by: n.author })),
        };
      }),
    });
  }),
);

adminResourcesRouter.post(
  "/recon",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        reference: z.string().min(1),
        customerName: z.string().min(1),
        source: z.string().min(1),
        variance: z.number(),
      })
      .parse(req.body);
    const records = await getConfigJson<StoredReconRecord[]>("admin.recon.records", []);
    const now = new Date().toISOString();
    const row: StoredReconRecord = {
      id: `rec_${nanoid(10)}`,
      reference: body.reference,
      customerName: body.customerName,
      source: body.source,
      variance: body.variance,
      status: "open",
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    records.unshift(row);
    await setConfigJson("admin.recon.records", records, req.adminId);
    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.patch(
  "/recon/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        status: z.enum(["open", "investigating", "resolved"]).optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const records = await getConfigJson<StoredReconRecord[]>("admin.recon.records", []);
    const idx = records.findIndex((r) => r.id === String(req.params.id));
    if (idx < 0) throw new AppError(404, "Record not found", "NOT_FOUND");
    const row = records[idx]!;
    if (body.status) row.status = body.status;
    if (body.note?.trim()) {
      row.notes.push({
        at: new Date().toISOString(),
        author: req.adminName || "Admin",
        body: body.note.trim(),
      });
    }
    row.updatedAt = new Date().toISOString();
    records[idx] = row;
    await setConfigJson("admin.recon.records", records, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "recon.updated",
      entityType: "ReconRecord",
      entityId: row.id,
      after: body,
    });
    res.json({ data: row });
  }),
);

adminResourcesRouter.get(
  "/campaigns",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const campaigns = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
    res.json({
      data: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        channel: c.channel,
        status: c.status,
        audience: c.audience,
        audienceId: c.audienceId ?? null,
        reach: c.reach ?? 0,
        title: c.subject,
        content: c.body,
        cta: c.cta || "Open Kipit",
        deepLink: c.deepLink || "/invest",
        scheduledFor: c.scheduledAt ?? undefined,
        sentAt: c.sentAt ?? undefined,
        delivered: c.delivered ?? 0,
        createdBy: "Admin",
      })),
    });
  }),
);

adminResourcesRouter.post(
  "/campaigns",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        channel: z.enum(["push", "email"]).default("push"),
        audience: z.string().default("All customers"),
        audienceId: z.string().optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        cta: z.string().optional(),
        deepLink: z.string().optional(),
        status: z.enum(["draft", "scheduled", "sending", "sent", "paused"]).default("draft"),
        scheduledAt: z.string().nullable().optional(),
      })
      .parse(req.body);
    const campaigns = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
    const now = new Date().toISOString();
    const row: StoredCampaign = {
      id: `cmp_${nanoid(10)}`,
      name: body.name,
      channel: body.channel,
      status: body.status,
      audience: body.audience,
      audienceId: body.audienceId ?? null,
      subject: body.subject,
      body: body.body,
      cta: body.cta ?? "Open Kipit",
      deepLink: body.deepLink ?? "/invest",
      scheduledAt: body.scheduledAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    campaigns.unshift(row);
    await setConfigJson("admin.campaigns", campaigns, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "campaign.created",
      entityType: "Campaign",
      entityId: row.id,
    });

    // Due scheduled / send-now creates: deliver immediately (push or email).
    const dueNow =
      body.status === "sending" ||
      (body.status === "scheduled" &&
        (!body.scheduledAt || new Date(body.scheduledAt).getTime() <= Date.now() + 5_000));
    if (dueNow) {
      const { sendMarketingCampaign } = await import("../jobs/marketing-campaigns.js");
      const result = await sendMarketingCampaign(row.id);
      res.status(201).json({ data: { ...row, ...result, status: result.status } });
      return;
    }

    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.patch(
  "/campaigns/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        status: z.enum(["draft", "scheduled", "sending", "sent", "paused"]).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        cta: z.string().optional(),
        deepLink: z.string().optional(),
        scheduledAt: z.string().nullable().optional(),
      })
      .parse(req.body);
    const campaigns = await getConfigJson<StoredCampaign[]>("admin.campaigns", []);
    const idx = campaigns.findIndex((c) => c.id === String(req.params.id));
    if (idx < 0) throw new AppError(404, "Campaign not found", "NOT_FOUND");
    const row = { ...campaigns[idx]!, ...body, updatedAt: new Date().toISOString() };
    campaigns[idx] = row;
    await setConfigJson("admin.campaigns", campaigns, req.adminId);

    if (body.status === "sending") {
      const { sendMarketingCampaign } = await import("../jobs/marketing-campaigns.js");
      const result = await sendMarketingCampaign(row.id);
      res.json({ data: { ...row, status: result.status, delivered: result.delivered, reach: result.recipients } });
      return;
    }

    res.json({ data: row });
  }),
);

adminResourcesRouter.post(
  "/campaigns/:id/send",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const { sendMarketingCampaign } = await import("../jobs/marketing-campaigns.js");
    try {
      const result = await sendMarketingCampaign(String(req.params.id));
      await writeAudit({
        actorAdminId: req.adminId,
        action: "campaign.sent",
        entityType: "Campaign",
        entityId: result.id,
        after: result,
      });
      res.json({ data: result });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.status === 404) throw new AppError(404, "Campaign not found", "NOT_FOUND");
      throw err;
    }
  }),
);

adminResourcesRouter.get(
  "/adjustments",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const requests = await getConfigJson<StoredAdjustment[]>("admin.adjustments", []);
    const placements = await prisma.placement.findMany({
      where: { status: "ACTIVE" },
      include: { user: true },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: {
        requests: requests.map((r) => ({
          id: r.id,
          investmentId: r.placementId,
          userName: r.customerName,
          product: r.product,
          reference: r.placementId,
          type:
            r.type === "maturity"
              ? "maturity-date"
              : r.type === "payout"
                ? "payout-frequency"
                : r.type === "status"
                  ? "status"
                  : r.type,
          previous: r.fromValue,
          proposed: r.toValue,
          reason: r.reason,
          submittedBy: r.maker,
          submittedAt: r.createdAt,
          status:
            r.status === "pending" ? "awaiting" : r.status === "approved" ? "approved" : "rejected",
          impact: `${r.type}: ${r.fromValue} → ${r.toValue}`,
          decidedAt: r.decidedAt ?? undefined,
          decisionNote: r.decisionNote ?? undefined,
        })),
        investments: placements.map((p) => ({
          id: p.id,
          userId: p.userId,
          userName: `${p.user.firstName} ${p.user.surname}`,
          userEmail: p.user.email ?? "",
          product: p.name,
          reference: p.id,
          principal: koboToNaira(p.principalKobo),
          rate: p.rateBps / 100,
          tenorDays: p.tenorDays ?? 0,
          startDate: p.startDate.toISOString().slice(0, 10),
          maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? "",
          payoutFrequency: "At maturity",
          status: p.status,
        })),
      },
    });
  }),
);

adminResourcesRouter.post(
  "/adjustments",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        placementId: z.string().min(1),
        type: z.enum(["principal", "rate", "tenor", "maturity", "payout", "status"]),
        toValue: z.string().min(1),
        reason: z.string().min(4),
      })
      .parse(req.body);
    const placement = await prisma.placement.findUnique({
      where: { id: body.placementId },
      include: { user: true },
    });
    if (!placement) throw new AppError(404, "Placement not found", "NOT_FOUND");

    const toValue = body.toValue.trim();
    if (body.type === "maturity") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toValue)) {
        throw new AppError(400, "Maturity date must be YYYY-MM-DD", "INVALID_VALUE");
      }
      const parsed = new Date(`${toValue}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== toValue) {
        throw new AppError(400, "Maturity date must be a valid calendar day", "INVALID_VALUE");
      }
    } else if (body.type === "rate") {
      const n = Number(toValue.replace(/%/g, "").trim());
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        throw new AppError(400, "Rate must be a percentage between 0.01 and 100", "INVALID_VALUE");
      }
    } else if (body.type === "tenor") {
      const n = Number(toValue.replace(/days/gi, "").trim());
      if (!Number.isInteger(n) || n < 1) {
        throw new AppError(400, "Tenor must be a whole number of days", "INVALID_VALUE");
      }
    } else if (body.type === "principal") {
      const n = Number(toValue.replace(/[₦,\s]/g, ""));
      if (!Number.isFinite(n) || n < 1000) {
        throw new AppError(400, "Principal must be at least ₦1,000", "INVALID_VALUE");
      }
    } else if (body.type === "payout") {
      if (!["WALLET", "ROLLOVER", "PAYOUT", "At maturity"].includes(toValue)) {
        throw new AppError(400, "Invalid payout instruction", "INVALID_VALUE");
      }
    } else if (body.type === "status") {
      if (!["ACTIVE", "MATURED", "CLOSED"].includes(toValue)) {
        throw new AppError(400, "Invalid plan status", "INVALID_VALUE");
      }
    }

    const fromValue =
      body.type === "principal"
        ? String(koboToNaira(placement.principalKobo))
        : body.type === "rate"
          ? `${(placement.rateBps / 100).toFixed(2)}%`
          : body.type === "tenor"
            ? `${placement.tenorDays ?? 0} days`
            : body.type === "maturity"
              ? placement.maturityDate?.toISOString().slice(0, 10) ?? ""
              : body.type === "payout"
                ? placement.maturityInstruction
                : placement.status;

    const normalizedTo =
      body.type === "rate"
        ? String(Number(toValue.replace(/%/g, "").trim()))
        : body.type === "tenor"
          ? String(Number(toValue.replace(/days/gi, "").trim()))
          : body.type === "principal"
            ? String(Number(toValue.replace(/[₦,\s]/g, "")))
            : toValue;

    const requests = await getConfigJson<StoredAdjustment[]>("admin.adjustments", []);
    const row: StoredAdjustment = {
      id: `adj_${nanoid(10)}`,
      placementId: placement.id,
      customerName: `${placement.user.firstName} ${placement.user.surname}`,
      product: placement.name,
      type: body.type,
      fromValue,
      toValue: normalizedTo,
      reason: body.reason,
      status: "pending",
      maker: req.adminName || "Admin",
      createdAt: new Date().toISOString(),
    };
    requests.unshift(row);
    await setConfigJson("admin.adjustments", requests, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "adjustment.submitted",
      entityType: "Adjustment",
      entityId: row.id,
    });
    res.status(201).json({ data: row });
  }),
);

adminResourcesRouter.post(
  "/adjustments/:id/decide",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        approve: z.boolean(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const requests = await getConfigJson<StoredAdjustment[]>("admin.adjustments", []);
    const idx = requests.findIndex((r) => r.id === String(req.params.id));
    if (idx < 0) throw new AppError(404, "Adjustment not found", "NOT_FOUND");
    const row = requests[idx]!;
    if (row.status !== "pending") throw new AppError(400, "Already decided", "ALREADY_DECIDED");
    row.status = body.approve ? "approved" : "rejected";
    row.decidedAt = new Date().toISOString();
    row.decisionNote = body.note ?? null;

    if (body.approve) {
      const data: {
        principalKobo?: bigint;
        rateBps?: number;
        tenorDays?: number;
        maturityDate?: Date;
        maturityInstruction?: "WALLET" | "ROLLOVER" | "PAYOUT";
        status?: "ACTIVE" | "MATURED" | "CLOSED";
      } = {};
      if (row.type === "principal") {
        data.principalKobo = nairaToKobo(Number(String(row.toValue).replace(/[₦,\s]/g, "")));
      }
      if (row.type === "rate") {
        data.rateBps = Math.round(Number(String(row.toValue).replace(/%/g, "").trim()) * 100);
      }
      if (row.type === "tenor") {
        data.tenorDays = Number(String(row.toValue).replace(/days/gi, "").trim());
      }
      if (row.type === "maturity") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.toValue)) {
          throw new AppError(400, "Maturity date must be YYYY-MM-DD", "INVALID_VALUE");
        }
        data.maturityDate = new Date(`${row.toValue}T00:00:00.000Z`);
      }
      if (row.type === "payout") {
        const mapped =
          row.toValue === "At maturity"
            ? "WALLET"
            : row.toValue === "WALLET" || row.toValue === "ROLLOVER" || row.toValue === "PAYOUT"
              ? row.toValue
              : null;
        if (!mapped) throw new AppError(400, "Invalid payout instruction", "INVALID_VALUE");
        data.maturityInstruction = mapped;
      }
      if (row.type === "status") {
        if (row.toValue !== "ACTIVE" && row.toValue !== "MATURED" && row.toValue !== "CLOSED") {
          throw new AppError(400, "Invalid plan status", "INVALID_VALUE");
        }
        data.status = row.toValue;
      }
      await prisma.placement.update({ where: { id: row.placementId }, data });
    }

    requests[idx] = row;
    await setConfigJson("admin.adjustments", requests, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: body.approve ? "adjustment.approved" : "adjustment.rejected",
      entityType: "Adjustment",
      entityId: row.id,
      after: body,
    });
    res.json({ data: row });
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
  asyncHandler(async (req, res) => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const in7 = new Date(now);
    in7.setDate(in7.getDate() + 7);
    in7.setHours(23, 59, 59, 999);
    const defaultEnd = new Date(now);
    defaultEnd.setDate(defaultEnd.getDate() + 90);
    defaultEnd.setHours(23, 59, 59, 999);

    const fromRaw = typeof req.query.from === "string" ? req.query.from : undefined;
    const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;
    const rangeStart = fromRaw ? new Date(fromRaw) : now;
    const rangeEnd = toRaw ? new Date(toRaw) : defaultEnd;
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
      throw new AppError(400, "Invalid from or to date", "VALIDATION");
    }
    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd.setHours(23, 59, 59, 999);

    const rows = await prisma.placement.findMany({
      where: {
        status: "ACTIVE",
        maturityDate: { gte: rangeStart, lte: rangeEnd },
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
          maturityDate: maturity.toISOString(),
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
  "/dashboard/flow-trend",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
    const start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const entries = await prisma.journalEntry.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: { lines: true },
    });

    type Bucket = { day: string; deposits: number; withdrawals: number; key: string };
    const buckets: Bucket[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      buckets.push({ key, day: dayNames[d.getDay()]!, deposits: 0, withdrawals: 0 });
    }
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));

    for (const e of entries) {
      const created = e.createdAt;
      const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`;
      const bucket = byKey[key];
      if (!bucket) continue;
      const abs = e.lines.reduce((s, l) => {
        const a = l.amountKobo < 0n ? -l.amountKobo : l.amountKobo;
        return a > s ? a : s;
      }, 0n);
      const millions = koboToNaira(abs) / 1_000_000;
      if (e.kind === "DEPOSIT" || e.kind === "CALL_DEPOSIT") bucket.deposits += millions;
      else if (e.kind === "WITHDRAWAL" || e.kind === "CALL_WITHDRAW") bucket.withdrawals += millions;
    }

    res.json({
      data: buckets.map(({ day, deposits, withdrawals }) => ({
        day,
        deposits,
        withdrawals,
      })),
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/interest-trend",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const { interestForPeriod } = await import("../services/money.js");
    const now = new Date();
    type MonthBucket = {
      key: string;
      month: string;
      start: Date;
      end: Date;
      accruedKobo: bigint;
      paidKobo: bigint;
    };

    const months: MonthBucket[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59, 999));
      const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
      const month = start.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
      months.push({ key, month, start, end, accruedKobo: 0n, paidKobo: 0n });
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
    const rangeStart = months[0]!.start;

    const interestAccounts = await prisma.ledgerAccount.findMany({
      where: { type: "SYSTEM_INTEREST" },
      select: { id: true },
    });
    const interestAccountIds = new Set(interestAccounts.map((a) => a.id));

    // Weekly/call interest credits.
    const interestEntries = await prisma.journalEntry.findMany({
      where: {
        kind: "INTEREST",
        createdAt: { gte: rangeStart },
      },
      include: { lines: { select: { accountId: true, amountKobo: true } } },
    });
    for (const e of interestEntries) {
      const key = `${e.createdAt.getUTCFullYear()}-${String(e.createdAt.getUTCMonth() + 1).padStart(2, "0")}`;
      const bucket = byKey[key];
      if (!bucket) continue;
      const paid = e.lines.reduce((s, l) => {
        const a = l.amountKobo < 0n ? -l.amountKobo : l.amountKobo;
        return a > s ? a : s;
      }, 0n);
      if (paid <= 0n) continue;
      bucket.paidKobo += paid;
      bucket.accruedKobo += paid;
    }

    // Plan maturity payouts — prefer placement.accruedKobo (set on settle).
    const matured = await prisma.placement.findMany({
      where: {
        status: "MATURED",
        OR: [{ maturityDate: { gte: rangeStart } }, { updatedAt: { gte: rangeStart } }],
      },
      select: { id: true, accruedKobo: true, maturityDate: true, updatedAt: true },
    });
    const maturityJournals = await prisma.journalEntry.findMany({
      where: {
        kind: "MATURITY",
        createdAt: { gte: rangeStart },
      },
      include: { lines: { select: { accountId: true, amountKobo: true } } },
    });
    const interestByPlacementId = new Map<string, bigint>();
    for (const j of maturityJournals) {
      const key = j.idempotencyKey || "";
      const id = key.replace(/^early-maturity-/, "").replace(/^maturity-/, "");
      if (!id || id === key) continue;
      const interest = j.lines.reduce((s, l) => {
        if (!interestAccountIds.has(l.accountId)) return s;
        const a = l.amountKobo < 0n ? -l.amountKobo : l.amountKobo;
        return s + a;
      }, 0n);
      if (interest > 0n) interestByPlacementId.set(id, interest);
    }
    for (const p of matured) {
      const when = p.maturityDate ?? p.updatedAt;
      const key = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
      const bucket = byKey[key];
      if (!bucket) continue;
      const interest = p.accruedKobo > 0n ? p.accruedKobo : interestByPlacementId.get(p.id) ?? 0n;
      if (interest <= 0n) continue;
      bucket.paidKobo += interest;
      bucket.accruedKobo += interest;
    }

    const activeFixed = await prisma.placement.findMany({
      where: { status: "ACTIVE", kind: { in: ["FIXED", "EXPLORE"] } },
      select: {
        principalKobo: true,
        rateBps: true,
        startDate: true,
        maturityDate: true,
      },
    });
    const dayMs = 24 * 60 * 60 * 1000;
    for (const m of months) {
      const monthCap = m.end.getTime() < now.getTime() ? m.end : now;
      for (const p of activeFixed) {
        const from = p.startDate.getTime() > m.start.getTime() ? p.startDate : m.start;
        const hardEnd =
          p.maturityDate && p.maturityDate.getTime() < monthCap.getTime() ? p.maturityDate : monthCap;
        if (hardEnd.getTime() <= from.getTime()) continue;
        const days = Math.max(0, Math.floor((hardEnd.getTime() - from.getTime()) / dayMs));
        if (days <= 0) continue;
        m.accruedKobo += interestForPeriod(p.principalKobo, p.rateBps, days);
      }
    }

    const rows = months.map((m) => ({
      month: m.month,
      accruedNaira: koboToNaira(m.accruedKobo),
      paidNaira: koboToNaira(m.paidKobo),
    }));
    const maxNaira = rows.reduce((s, r) => Math.max(s, r.accruedNaira, r.paidNaira), 0);
    const scale =
      maxNaira >= 1_000_000
        ? { divisor: 1_000_000, unit: "millions" as const, label: "₦ millions" }
        : maxNaira >= 1_000
          ? { divisor: 1_000, unit: "thousands" as const, label: "₦ thousands" }
          : { divisor: 1, unit: "naira" as const, label: "₦" };

    res.json({
      data: {
        scale,
        series: rows.map((r) => ({
          month: r.month,
          accrued: r.accruedNaira / scale.divisor,
          paid: r.paidNaira / scale.divisor,
          accruedNaira: r.accruedNaira,
          paidNaira: r.paidNaira,
        })),
      },
    });
  }),
);

adminResourcesRouter.get(
  "/dashboard/maturity-schedule",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    // Align to Monday of the current week (local).
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const week0 = new Date(now);
    week0.setDate(now.getDate() + mondayOffset);
    week0.setHours(0, 0, 0, 0);

    const horizonEnd = new Date(week0);
    horizonEnd.setDate(week0.getDate() + 7 * 6 - 1);
    horizonEnd.setHours(23, 59, 59, 999);

    // Include already-matured plans in-window so payouts show on the chart.
    const rows = await prisma.placement.findMany({
      where: {
        status: { in: ["ACTIVE", "MATURED"] },
        maturityDate: { gte: week0, lte: horizonEnd },
      },
      select: {
        principalKobo: true,
        rateBps: true,
        tenorDays: true,
        maturityDate: true,
        accruedKobo: true,
        status: true,
      },
    });

    type WeekBucket = { week: string; valueKobo: bigint; start: Date; end: Date };
    const buckets: WeekBucket[] = [];
    for (let i = 0; i < 6; i += 1) {
      const start = new Date(week0);
      start.setDate(week0.getDate() + i * 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      buckets.push({ week: `W${i + 1}`, valueKobo: 0n, start, end });
    }

    for (const p of rows) {
      if (!p.maturityDate) continue;
      const interest =
        p.status === "MATURED" && p.accruedKobo > 0n
          ? p.accruedKobo
          : (p.principalKobo * BigInt(p.rateBps) * BigInt(p.tenorDays ?? 0)) / 365n / 10000n;
      const expected = p.principalKobo + interest;
      const bucket = buckets.find(
        (b) => p.maturityDate! >= b.start && p.maturityDate! <= b.end,
      );
      if (bucket) bucket.valueKobo += expected;
    }

    const mapped = buckets.map((b) => ({
      week: b.week,
      valueNaira: koboToNaira(b.valueKobo),
      from: b.start.toISOString().slice(0, 10),
      to: b.end.toISOString().slice(0, 10),
    }));
    const maxNaira = mapped.reduce((s, r) => Math.max(s, r.valueNaira), 0);
    const scale =
      maxNaira >= 1_000_000
        ? { divisor: 1_000_000, unit: "millions" as const, label: "₦ millions" }
        : maxNaira >= 1_000
          ? { divisor: 1_000, unit: "thousands" as const, label: "₦ thousands" }
          : { divisor: 1, unit: "naira" as const, label: "₦" };

    res.json({
      data: {
        scale,
        series: mapped.map((b) => ({
          week: b.week,
          value: b.valueNaira / scale.divisor,
          valueNaira: b.valueNaira,
          from: b.from,
          to: b.to,
        })),
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

adminResourcesRouter.get(
  "/referrals/stats",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [invited, totalUsers, leaders] = await Promise.all([
      prisma.user.count({ where: { referredBy: { not: null } } }),
      prisma.user.count(),
      prisma.user.groupBy({
        by: ["referredBy"],
        where: { referredBy: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { referredBy: "desc" } },
        take: 10,
      }),
    ]);

    const codes = leaders
      .map((l) => l.referredBy)
      .filter((c): c is string => Boolean(c));
    const inviters = codes.length
      ? await prisma.user.findMany({
          where: { referralCode: { in: codes } },
          select: { referralCode: true, firstName: true, surname: true, email: true },
        })
      : [];
    const inviterByCode = new Map(inviters.map((u) => [u.referralCode, u]));

    res.json({
      data: {
        invitesSent: invited,
        invitesQualified: invited,
        rewardsPaid: 0,
        pendingApproval: 0,
        totalUsers,
        leaders: leaders.map((l) => {
          const inviter = l.referredBy ? inviterByCode.get(l.referredBy) : undefined;
          return {
            name: inviter
              ? `${inviter.firstName} ${inviter.surname}`.trim()
              : l.referredBy || "—",
            email: inviter?.email ?? null,
            invites: l._count._all,
            qualified: l._count._all,
            rewarded: 0,
          };
        }),
      },
    });
  }),
);
