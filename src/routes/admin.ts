import {
  creditWalletFrom,
  ensureSystemAccount,
  ensureUserCall,
  ensureUserWallet,
} from "../services/money.js";
import type { Request, Response, NextFunction } from "express";
import { asyncHandler, AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { hashSecret, verifySecret, koboToNaira } from "../lib/crypto.js";
import { adminReviewKyc, getKycStatus } from "../services/kyc.js";
import { writeAudit } from "../services/audit.js";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Router } from "express";

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
    else if (p.kind === "FIXED") fixed += p.principalKobo;
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

const adminRoleSchema = z.enum(["SUPER", "GLOBAL", "COMPLIANCE", "OPERATIONS", "MARKETING"]);

export const adminRouter = Router();

adminRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);
    const admin = await prisma.adminUser.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!admin || !(await verifySecret(body.password, admin.passwordHash))) {
      throw new AppError(401, "Invalid credentials", "AUTH_FAILED");
    }
    const session = await prisma.adminSession.create({
      data: { adminId: admin.id, refreshTokenHash: "admin" },
    });
    const accessToken = jwt.sign(
      { sub: admin.id, sid: session.id, typ: "admin", role: admin.role },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "8h" },
    );
    res.json({
      data: {
        accessToken,
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      },
    });
  }),
);

adminRouter.post(
  "/logout",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sid?: string; sub?: string };
    if (payload.sid && payload.sub) {
      await prisma.adminSession.updateMany({
        where: { id: payload.sid, adminId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.status(204).send();
  }),
);

adminRouter.get(
  "/dashboard",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const wallets = await prisma.ledgerAccount.aggregate({
      where: { type: "USER_WALLET" },
      _sum: { balanceKobo: true },
    });
    const call = await prisma.ledgerAccount.aggregate({
      where: { type: "USER_CALL" },
      _sum: { balanceKobo: true },
    });
    const placements = await prisma.placement.aggregate({
      where: { status: "ACTIVE" },
      _sum: { principalKobo: true },
    });
    const users = await prisma.user.count();
    const pendingKyc = await prisma.kycProfile.count({ where: { status: "PENDING_REVIEW" } });
    const pendingWithdrawals = await prisma.withdrawalRequest.count({
      where: { status: "PROCESSING" },
    });
    const recentAudit = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    const fum =
      (wallets._sum.balanceKobo ?? 0n) +
      (call._sum.balanceKobo ?? 0n) +
      (placements._sum.principalKobo ?? 0n);

    res.json({
      data: {
        fum: koboToNaira(fum),
        users,
        pendingKyc,
        pendingWithdrawals,
        interestAccrued: 0,
        interestPayable: 0,
        recentAudit,
        breakdown: {
          wallet: koboToNaira(wallets._sum.balanceKobo ?? 0n),
          call: koboToNaira(call._sum.balanceKobo ?? 0n),
          placements: koboToNaira(placements._sum.principalKobo ?? 0n),
        },
      },
    });
  }),
);

adminRouter.get(
  "/users",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const users = await prisma.user.findMany({
      where: q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { firstName: { contains: q, mode: "insensitive" } },
              { surname: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          }
        : undefined,
      take: 100,
      orderBy: { createdAt: "desc" },
      include: {
        ledgerAccounts: true,
        placements: { where: { status: "ACTIVE" } },
        sessions: { where: { revokedAt: null }, orderBy: { lastActiveAt: "desc" }, take: 1 },
        kycProfile: true,
      },
    });
    res.json({
      data: users.map((u) => {
        const wallet =
          u.ledgerAccounts.find((a) => a.type === "USER_WALLET")?.balanceKobo ?? 0n;
        const call = u.ledgerAccounts.find((a) => a.type === "USER_CALL")?.balanceKobo ?? 0n;
        let fixed = 0n;
        let explore = 0n;
        for (const p of u.placements) {
          if (p.kind === "EXPLORE") explore += p.principalKobo;
          else if (p.kind === "FIXED") fixed += p.principalKobo;
        }
        const last = u.sessions[0]?.lastActiveAt ?? u.updatedAt;
        const status =
          u.frozen
            ? "frozen"
            : u.kycProfile?.status === "PENDING_REVIEW" || u.kycTier === "TIER_0"
              ? "pending"
              : "active";
        return {
          id: u.id,
          email: u.email,
          phone: u.phone,
          name: `${u.firstName} ${u.surname}`,
          kycTier: u.kycTier,
          frozen: u.frozen,
          createdAt: u.createdAt,
          lastActiveAt: last,
          status,
          balances: {
            wallet: koboToNaira(wallet),
            call: koboToNaira(call),
            fixed: koboToNaira(fixed),
            explore: koboToNaira(explore),
          },
        };
      }),
    });
  }),
);

adminRouter.get(
  "/users/:userId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    const balances = await userBalances(userId);
    const lastSession = await prisma.session.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
    });
    const kyc = await getKycStatus(userId).catch(() => null);
    const lastActiveAt = lastSession?.lastActiveAt ?? user.updatedAt;
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
        lastActiveAt,
        lastActive: fmtRelative(lastActiveAt),
        balances,
        kyc,
      },
    });
  }),
);

adminRouter.get(
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
      include: { entry: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const seen = new Set<string>();
    const rows = [];
    for (const line of lines) {
      if (seen.has(line.entryId)) continue;
      seen.add(line.entryId);
      if (rows.length >= 100) break;
      rows.push({
        id: line.entry.id,
        reference: line.entry.reference,
        kind: line.entry.kind,
        amount: koboToNaira(line.amountKobo < 0n ? -line.amountKobo : line.amountKobo),
        direction: line.amountKobo < 0n ? "debit" : "credit",
        createdAt: line.entry.createdAt,
        description: line.entry.description,
      });
    }
    res.json({ data: rows });
  }),
);

adminRouter.get(
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

adminRouter.get(
  "/users/:userId/sessions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.session.findMany({
      where: { userId: String(req.params.userId), revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
    });
    res.json({
      data: rows.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
      })),
    });
  }),
);

adminRouter.patch(
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
    res.json({ data: { id: user.id, frozen: user.frozen } });
  }),
);

adminRouter.get(
  "/kyc/queue",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.kycProfile.findMany({
      where: { status: "PENDING_REVIEW" },
      include: { user: true },
      orderBy: { updatedAt: "asc" },
    });
    res.json({
      data: rows.map((r) => ({
        userId: r.userId,
        name: `${r.user.firstName} ${r.user.surname}`,
        email: r.user.email,
        status: r.status,
        updatedAt: r.updatedAt,
      })),
    });
  }),
);

adminRouter.post(
  "/kyc/:userId/review",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({ approve: z.boolean(), reason: z.string().optional() })
      .parse(req.body);
    const result = await adminReviewKyc({
      userId: String(req.params.userId),
      adminId: req.adminId!,
      approve: body.approve,
      reason: body.reason,
    });
    res.json({ data: result });
  }),
);

adminRouter.get(
  "/withdrawals",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.withdrawalRequest.findMany({
      include: { user: true, payoutBank: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        amount: koboToNaira(r.amountKobo),
        declineReason: r.declineReason,
        user: {
          id: r.userId,
          name: `${r.user.firstName} ${r.user.surname}`,
          email: r.user.email,
          phone: r.user.phone,
          kycTier: r.user.kycTier,
          createdAt: r.user.createdAt,
        },
        bank: r.payoutBank.bankName,
        accountName: r.payoutBank.accountName,
        accountNumber: r.payoutBank.accountNumber,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
      })),
    });
  }),
);

adminRouter.post(
  "/withdrawals/:id/complete",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: String(req.params.id) },
      include: { payoutBank: true },
    });
    if (row.status !== "PROCESSING") throw new AppError(400, "Not processing", "INVALID_STATE");

    const { initiatePaystackTransfer } = await import("../services/payments/paystack.js");
    const transfer = await initiatePaystackTransfer({
      amountKobo: Number(row.amountKobo),
      reference: row.reference,
      reason: "Kipit withdrawal",
      accountNumber: row.payoutBank.accountNumber,
      bankCode: row.payoutBank.bankCode,
      accountName: row.payoutBank.accountName,
    });

    await prisma.withdrawalRequest.update({
      where: { id: row.id },
      data: {
        status: "SUCCESSFUL",
        processedAt: new Date(),
        processedByAdminId: req.adminId,
        providerRef: transfer.transferCode,
      },
    });
    await prisma.notification.create({
      data: {
        userId: row.userId,
        title: "Withdrawal successful",
        body: `Your withdrawal of ₦${koboToNaira(row.amountKobo).toLocaleString()} was paid out.`,
        href: "/withdraw/tracker",
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "withdrawal.successful",
      entityType: "WithdrawalRequest",
      entityId: row.id,
      after: { transfer },
    });
    res.json({ data: { id: row.id, status: "SUCCESSFUL", transfer } });
  }),
);

adminRouter.post(
  "/withdrawals/:id/decline",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: String(req.params.id) },
    });
    if (row.status !== "PROCESSING") throw new AppError(400, "Not processing", "INVALID_STATE");

    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    await creditWalletFrom({
      userId: row.userId,
      amountKobo: row.amountKobo,
      kind: "WITHDRAWAL",
      idempotencyKey: `wdr-decline-${row.id}`,
      description: "Withdrawal declined — re-credit",
      debitAccountId: suspense.id,
    });

    await prisma.withdrawalRequest.update({
      where: { id: row.id },
      data: {
        status: "DECLINED",
        declineReason: body.reason,
        processedAt: new Date(),
        processedByAdminId: req.adminId,
      },
    });

    await prisma.notification.create({
      data: {
        userId: row.userId,
        title: "Withdrawal declined",
        body: body.reason,
        href: "/withdraw/tracker",
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "withdrawal.declined",
      entityType: "WithdrawalRequest",
      entityId: row.id,
      after: { reason: body.reason },
    });

    res.json({ data: { id: row.id, status: "DECLINED" } });
  }),
);

adminRouter.get(
  "/withdrawals/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const r = await prisma.withdrawalRequest.findUnique({
      where: { id: String(req.params.id) },
      include: { user: true, payoutBank: true },
    });
    if (!r) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    res.json({
      data: {
        id: r.id,
        reference: r.reference,
        status: r.status,
        amount: koboToNaira(r.amountKobo),
        declineReason: r.declineReason,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
        user: {
          id: r.user.id,
          email: r.user.email,
          phone: r.user.phone,
          name: `${r.user.firstName} ${r.user.surname}`,
          kycTier: r.user.kycTier,
        },
        payoutBank: {
          bankName: r.payoutBank.bankName,
          accountName: r.payoutBank.accountName,
          accountNumber: r.payoutBank.accountNumber,
        },
      },
    });
  }),
);

adminRouter.get(
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
        const userLine = e.lines.find((l) => l.account.userId && l.account.type === "USER_WALLET");
        const user = userLine?.account.user ?? e.lines.find((l) => l.account.user)?.account.user;
        const amountLine = e.lines.find((l) => l.amountKobo !== 0n) ?? e.lines[0];
        const amountKobo = amountLine
          ? amountLine.amountKobo < 0n
            ? -amountLine.amountKobo
            : amountLine.amountKobo
          : 0n;
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

adminRouter.get(
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

adminRouter.get(
  "/rates",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" } });
    res.json({ data: bands });
  }),
);

adminRouter.post(
  "/rates/propose",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        bandId: z.string(),
        proposedBps: z.number().int().positive(),
        effectiveFrom: z.string(),
        reason: z.string().optional(),
      })
      .parse(req.body);
    const row = await prisma.rateChangeRequest.create({
      data: {
        bandId: body.bandId,
        proposedBps: body.proposedBps,
        effectiveFrom: new Date(body.effectiveFrom),
        reason: body.reason,
        makerAdminId: req.adminId!,
      },
    });
    res.status(201).json({ data: row });
  }),
);

adminRouter.post(
  "/rates/:requestId/decide",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    const row = await prisma.rateChangeRequest.findUniqueOrThrow({
      where: { id: String(req.params.requestId) },
    });
    if (row.status !== "PENDING") throw new AppError(400, "Already decided", "INVALID_STATE");
    if (row.makerAdminId === req.adminId) {
      throw new AppError(403, "Maker cannot approve own request", "MAKER_CHECKER");
    }

    if (body.approve) {
      await prisma.$transaction([
        prisma.rateBand.update({
          where: { id: row.bandId },
          data: { rateBps: row.proposedBps, effectiveFrom: row.effectiveFrom },
        }),
        prisma.rateChangeRequest.update({
          where: { id: row.id },
          data: {
            status: "APPROVED",
            checkerAdminId: req.adminId,
            decidedAt: new Date(),
          },
        }),
      ]);
    } else {
      await prisma.rateChangeRequest.update({
        where: { id: row.id },
        data: {
          status: "REJECTED",
          checkerAdminId: req.adminId,
          decidedAt: new Date(),
        },
      });
    }

    res.json({ data: { id: row.id, status: body.approve ? "APPROVED" : "REJECTED" } });
  }),
);

adminRouter.get(
  "/rates/requests",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.rateChangeRequest.findMany({
      include: { band: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    rows.sort((a, b) => {
      if (a.status === "PENDING" && b.status !== "PENDING") return -1;
      if (b.status === "PENDING" && a.status !== "PENDING") return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
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
        effectiveFrom: r.effectiveFrom,
        reason: r.reason,
        status: r.status,
        submittedBy: byId[r.makerAdminId]?.name ?? r.makerAdminId,
        decidedBy: r.checkerAdminId ? (byId[r.checkerAdminId]?.name ?? r.checkerAdminId) : null,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
      })),
    });
  }),
);

adminRouter.get(
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

adminRouter.patch(
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
      after: { status: row.status, adminNote: body.adminNote },
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

adminRouter.get(
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
        category: { id: p.categoryId, slug: p.category.slug, name: p.category.name },
        createdAt: p.createdAt,
      })),
    });
  }),
);

adminRouter.post(
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
        termsVersion: z.string().optional(),
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
        termsVersion: body.termsVersion,
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

adminRouter.patch(
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

adminRouter.get(
  "/marketing/feed",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.feedCard.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({ data: rows });
  }),
);

adminRouter.post(
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

adminRouter.patch(
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

adminRouter.get(
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

adminRouter.post(
  "/team",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(2),
        role: adminRoleSchema,
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

adminRouter.patch(
  "/team/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        role: adminRoleSchema.optional(),
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

adminRouter.get(
  "/audit",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ data: rows });
  }),
);

adminRouter.get(
  "/jobs",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const runs = await prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
    res.json({ data: runs });
  }),
);
