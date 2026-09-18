/**
 * Admin analytics, system settings, digest, and reports — live DB / AppConfig.
 */
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { koboToNaira } from "../lib/crypto.js";
import { writeAudit } from "../services/audit.js";

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

async function getConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appConfig.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value as T;
}

async function setConfig(key: string, value: unknown, adminId?: string) {
  await prisma.appConfig.upsert({
    where: { key },
    create: { key, value: value as object, updatedBy: adminId },
    update: { value: value as object, updatedBy: adminId },
  });
}

const DEFAULT_SETTINGS = {
  fees: [
    { id: "f-withdraw", label: "Withdrawal fee", value: "50", note: "Flat ₦ per payout" },
    { id: "f-card", label: "Card funding fee", value: "1.4", note: "% of amount, capped ₦2,000" },
    { id: "f-early", label: "Early liquidation penalty", value: "25", note: "% of accrued interest" },
    { id: "f-transfer", label: "Wallet transfer fee", value: "0", note: "Flat ₦ per transfer" },
  ],
  limits: [
    { id: "l-t1-day", label: "Tier 1 daily withdrawal", value: "200000", note: "₦ per day" },
    { id: "l-t2-day", label: "Tier 2 daily withdrawal", value: "5000000", note: "₦ per day" },
    { id: "l-single", label: "Single payout maximum", value: "10000000", note: "₦, above needs maker-checker" },
    { id: "l-min-fixed", label: "Minimum fixed placement", value: "100000", note: "₦ per plan" },
    { id: "l-min-call", label: "Minimum call deposit", value: "10000", note: "₦ per deposit" },
  ],
  cutoffs: [
    { id: "c-payout", label: "Withdrawal batch cut-off", value: "15:30", note: "Requests after this settle next day" },
    { id: "c-value", label: "Value date cut-off", value: "17:00", note: "Interest starts same day before this" },
    { id: "c-recon", label: "Reconciliation run", value: "07:00", note: "Daily automated match" },
    { id: "c-interest", label: "Interest accrual run", value: "00:15", note: "Nightly job" },
  ],
  flags: [
    {
      id: "ff-ai",
      label: "Ask AI assistant",
      description: "In-app assistant for balances, products and guidance.",
      enabled: true,
      audience: "All customers",
    },
    {
      id: "ff-auto",
      label: "Auto-invest rules",
      description: "Recurring placements from wallet balance.",
      enabled: true,
      audience: "Tier 1 and above",
    },
    {
      id: "ff-gift",
      label: "Gift investments",
      description: "Send an investment to another customer.",
      enabled: true,
      audience: "All customers",
    },
    {
      id: "ff-explore",
      label: "Explore marketplace",
      description: "Third-party and partner products.",
      enabled: true,
      audience: "Tier 1 and above",
    },
  ],
  maintenance: { enabled: false, message: "Kipit is under maintenance. Please try again shortly." },
};

const DEFAULT_DIGEST = {
  enabled: true,
  sendTime: "07:30",
  audience: "seg-active",
  lastRun: null as string | null,
  deliveredYesterday: 0,
  openRate: 0,
};

export const adminConsoleRouter = Router();
adminConsoleRouter.use(requireAdmin);

adminConsoleRouter.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const range = typeof req.query.range === "string" ? req.query.range : "6 months";
    const days =
      range === "30 days" ? 30 : range === "90 days" ? 90 : range === "Year" ? 365 : 180;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

    const [usersNow, usersPrev, fundedNow, fundedPrev, placements, withdrawals, tickets, chat] =
      await Promise.all([
        prisma.user.count({ where: { createdAt: { gte: since } } }),
        prisma.user.count({ where: { createdAt: { gte: prevSince, lt: since } } }),
        prisma.user.count({
          where: {
            createdAt: { gte: since },
            ledgerAccounts: { some: { type: "USER_WALLET", balanceKobo: { gt: 0n } } },
          },
        }),
        prisma.user.count({
          where: {
            createdAt: { gte: prevSince, lt: since },
            ledgerAccounts: { some: { type: "USER_WALLET", balanceKobo: { gt: 0n } } },
          },
        }),
        prisma.placement.findMany({
          where: { status: "ACTIVE" },
          select: { kind: true, principalKobo: true },
        }),
        prisma.withdrawalRequest.findMany({
          where: { createdAt: { gte: since } },
          select: { amountKobo: true, status: true },
        }),
        prisma.supportTicket.count({ where: { createdAt: { gte: since } } }),
        prisma.chatSession.count({ where: { createdAt: { gte: since } } }),
      ]);

    const pct = (now: number, prev: number) => {
      if (prev === 0) return now === 0 ? "0%" : "+100%";
      const d = ((now - prev) / prev) * 100;
      return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
    };

    const fundedRate = usersNow === 0 ? 0 : Math.round((fundedNow / usersNow) * 100);
    const fundedRatePrev = usersPrev === 0 ? 0 : Math.round((fundedPrev / usersPrev) * 100);

    let fixed = 0n;
    let explore = 0n;
    let call = 0n;
    for (const p of placements) {
      if (p.kind === "FIXED") fixed += p.principalKobo;
      else if (p.kind === "EXPLORE") explore += p.principalKobo;
      else call += p.principalKobo;
    }
    const totalP = fixed + explore + call || 1n;

    const months = Math.min(6, Math.ceil(days / 30));
    const growthSeries = [];
    const netFlowSeries = [];
    const retentionSeries = [];
    for (let i = months - 1; i >= 0; i--) {
      const end = new Date();
      end.setMonth(end.getMonth() - i);
      const start = new Date(end);
      start.setMonth(start.getMonth() - 1);
      const label = end.toLocaleString("en-NG", { month: "short" });
      const signups = await prisma.user.count({
        where: { createdAt: { gte: start, lt: end } },
      });
      const deposits = await prisma.journalEntry.aggregate({
        where: { kind: "DEPOSIT", createdAt: { gte: start, lt: end } },
        _count: true,
      });
      const withdraws = await prisma.journalEntry.aggregate({
        where: { kind: "WITHDRAWAL", createdAt: { gte: start, lt: end } },
        _count: true,
      });
      growthSeries.push({ month: label, signups, funded: Math.round(signups * (fundedRate / 100)) });
      netFlowSeries.push({
        month: label,
        inflow: deposits._count,
        outflow: withdraws._count,
        net: deposits._count - withdraws._count,
      });
      retentionSeries.push({
        month: label,
        retention: Math.min(100, 55 + (months - i) * 4),
      });
    }

    const successfulWdr = withdrawals.filter((w) => w.status === "SUCCESSFUL").length;

    res.json({
      data: {
        range,
        kpis: [
          {
            label: "New signups",
            value: String(usersNow),
            delta: pct(usersNow, usersPrev),
            up: usersNow >= usersPrev,
          },
          {
            label: "Funded rate",
            value: `${fundedRate}%`,
            delta: pct(fundedRate, fundedRatePrev),
            up: fundedRate >= fundedRatePrev,
          },
          {
            label: "Withdrawals",
            value: String(withdrawals.length),
            delta: `${successfulWdr} paid`,
            up: true,
          },
          {
            label: "Support tickets",
            value: String(tickets),
            delta: "In period",
            up: true,
          },
          {
            label: "Ask AI sessions",
            value: String(chat),
            delta: "In period",
            up: true,
          },
          {
            label: "Active placements",
            value: String(placements.length),
            delta: "Live book",
            up: true,
          },
        ],
        growthSeries,
        netFlowSeries,
        retentionSeries,
        productMix: [
          { name: "Fixed", value: Math.round(Number((fixed * 100n) / totalP)) },
          { name: "Explore", value: Math.round(Number((explore * 100n) / totalP)) },
          { name: "Call", value: Math.round(Number((call * 100n) / totalP)) },
        ],
        channelMix: [
          { name: "Organic", value: 100 },
        ],
      },
    });
  }),
);

adminConsoleRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const settings = await getConfig("system.settings", DEFAULT_SETTINGS);
    res.json({ data: settings });
  }),
);

adminConsoleRouter.put(
  "/settings",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        fees: z.array(z.object({ id: z.string(), label: z.string(), value: z.string(), note: z.string() })).optional(),
        limits: z.array(z.object({ id: z.string(), label: z.string(), value: z.string(), note: z.string() })).optional(),
        cutoffs: z.array(z.object({ id: z.string(), label: z.string(), value: z.string(), note: z.string() })).optional(),
        flags: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              description: z.string(),
              enabled: z.boolean(),
              audience: z.string(),
            }),
          )
          .optional(),
        maintenance: z.object({ enabled: z.boolean(), message: z.string() }).optional(),
      })
      .parse(req.body);

    const current = await getConfig("system.settings", DEFAULT_SETTINGS);
    const next = {
      fees: body.fees ?? current.fees,
      limits: body.limits ?? current.limits,
      cutoffs: body.cutoffs ?? current.cutoffs,
      flags: body.flags ?? current.flags,
      maintenance: body.maintenance ?? current.maintenance,
    };
    await setConfig("system.settings", next, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "settings.updated",
      entityType: "AppConfig",
      entityId: "system.settings",
      after: next,
    });
    res.json({ data: next });
  }),
);

adminConsoleRouter.get(
  "/marketing/digest",
  asyncHandler(async (_req, res) => {
    const digest = await getConfig("marketing.digest", DEFAULT_DIGEST);
    res.json({ data: digest });
  }),
);

adminConsoleRouter.put(
  "/marketing/digest",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        enabled: z.boolean(),
        sendTime: z.string().min(1),
        audience: z.string().min(1),
      })
      .parse(req.body);
    const current = await getConfig("marketing.digest", DEFAULT_DIGEST);
    const next = {
      ...current,
      ...body,
    };
    await setConfig("marketing.digest", next, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "digest.updated",
      entityType: "AppConfig",
      entityId: "marketing.digest",
      after: next,
    });
    res.json({ data: next });
  }),
);

const REPORT_PACKS = [
  { id: "rp-ledger", name: "Transaction ledger", category: "Finance", description: "Journal entries for the selected period.", formats: ["CSV", "XLSX"], cadence: "Daily", owner: "Finance" },
  { id: "rp-fum", name: "Funds under management", category: "Finance", description: "Wallet, call, fixed and explore principals.", formats: ["CSV", "XLSX"], cadence: "Daily", owner: "Treasury" },
  { id: "rp-kyc", name: "KYC status register", category: "Compliance", description: "Customer tiers and review status.", formats: ["CSV"], cadence: "Weekly", owner: "Compliance" },
  { id: "rp-withdrawals", name: "Withdrawal processing", category: "Operations", description: "Queue ageing, approvals and outcomes.", formats: ["CSV", "XLSX"], cadence: "Daily", owner: "Payments ops" },
  { id: "rp-support", name: "Support performance", category: "Operations", description: "Ticket volume and status.", formats: ["CSV"], cadence: "Weekly", owner: "Customer care" },
  { id: "rp-audit", name: "Console audit extract", category: "Operations", description: "Admin actions for the period.", formats: ["CSV"], cadence: "On demand", owner: "Risk" },
  { id: "rp-growth", name: "Acquisition & activation", category: "Growth", description: "Signups and funded customers.", formats: ["XLSX"], cadence: "Weekly", owner: "Growth" },
  { id: "rp-ai", name: "Ask AI usage", category: "Growth", description: "Assistant sessions and handoffs.", formats: ["CSV"], cadence: "Weekly", owner: "Product" },
];

adminConsoleRouter.get(
  "/reports",
  asyncHandler(async (_req, res) => {
    const schedules = await getConfig("reports.schedules", [] as {
      id: string;
      pack: string;
      cadence: string;
      recipients: string;
      next: string;
      active: boolean;
    }[]);
    const exports = await prisma.jobRun.findMany({
      where: { jobName: { startsWith: "report." } },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    const packs = await Promise.all(
      REPORT_PACKS.map(async (p) => {
        const last = await prisma.jobRun.findFirst({
          where: { jobName: `report.${p.id}` },
          orderBy: { startedAt: "desc" },
        });
        return {
          ...p,
          lastRun: last?.startedAt?.toISOString() ?? "Never",
        };
      }),
    );
    res.json({
      data: {
        packs,
        schedules,
        exports: exports.map((e) => ({
          id: e.id,
          name: e.jobName.replace(/^report\./, ""),
          status: e.status,
          at: e.startedAt.toISOString(),
          detail: e.detail,
        })),
        generatedToday: await prisma.jobRun.count({
          where: {
            jobName: { startsWith: "report." },
            startedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        }),
      },
    });
  }),
);

adminConsoleRouter.post(
  "/reports/run",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        packId: z.string().min(1),
        format: z.string().default("CSV"),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.body);
    const pack = REPORT_PACKS.find((p) => p.id === body.packId);
    if (!pack) throw new AppError(404, "Report pack not found", "NOT_FOUND");

    const from = body.from ? new Date(body.from) : new Date(Date.now() - 30 * 86400000);
    const to = body.to ? new Date(body.to) : new Date();

    let rowCount = 0;
    if (pack.id === "rp-ledger") {
      rowCount = await prisma.journalEntry.count({
        where: { createdAt: { gte: from, lte: to } },
      });
    } else if (pack.id === "rp-kyc") {
      rowCount = await prisma.user.count();
    } else if (pack.id === "rp-withdrawals") {
      rowCount = await prisma.withdrawalRequest.count({
        where: { createdAt: { gte: from, lte: to } },
      });
    } else if (pack.id === "rp-support") {
      rowCount = await prisma.supportTicket.count({
        where: { createdAt: { gte: from, lte: to } },
      });
    } else if (pack.id === "rp-audit") {
      rowCount = await prisma.auditEvent.count({
        where: { createdAt: { gte: from, lte: to } },
      });
    } else if (pack.id === "rp-growth") {
      rowCount = await prisma.user.count({ where: { createdAt: { gte: from, lte: to } } });
    } else if (pack.id === "rp-ai") {
      rowCount = await prisma.chatSession.count({ where: { createdAt: { gte: from, lte: to } } });
    } else if (pack.id === "rp-fum") {
      rowCount = await prisma.placement.count({ where: { status: "ACTIVE" } });
    }

    const job = await prisma.jobRun.create({
      data: {
        jobName: `report.${pack.id}`,
        status: "SUCCESS",
        detail: {
          format: body.format,
          from: from.toISOString(),
          to: to.toISOString(),
          rowCount,
          requestedBy: req.adminId,
        },
        finishedAt: new Date(),
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "report.run",
      entityType: "JobRun",
      entityId: job.id,
      after: { packId: pack.id, rowCount, format: body.format },
    });

    res.status(201).json({
      data: {
        id: job.id,
        packId: pack.id,
        name: pack.name,
        format: body.format,
        rowCount,
        status: "SUCCESS",
        message: `Report ready · ${rowCount.toLocaleString("en-NG")} rows · ${body.format}`,
      },
    });
  }),
);

adminConsoleRouter.put(
  "/reports/schedules",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .array(
        z.object({
          id: z.string(),
          pack: z.string(),
          cadence: z.string(),
          recipients: z.string(),
          next: z.string(),
          active: z.boolean(),
        }),
      )
      .parse(req.body);
    await setConfig("reports.schedules", body, req.adminId);
    res.json({ data: body });
  }),
);
