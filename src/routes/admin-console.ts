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
import { formatReportDate, formatReportDateTime } from "../lib/report-dates.js";
import { writeAudit } from "../services/audit.js";
import {
  interestBreakdownFromNetAmount,
  interestBreakdownFromNetRate,
} from "../services/wht.js";
import { displayPlanName } from "../services/lock-flex-rates.js";

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
  maintenance: {
    enabled: false,
    message: "Kipit is under maintenance. Please try again shortly.",
    windowStart: null as string | null,
    windowEnd: null as string | null,
  },
  support: {
    phone: "+2347000547480",
    /** Digits with country code, no + or spaces — used to build https://wa.me/{whatsapp} */
    whatsapp: "",
    email: "support@kipit.ng",
  },
};

export type SystemSupportContacts = {
  phone: string;
  whatsapp: string;
  email: string;
};

/** Public-safe slice of system settings for the customer apps. */
export async function getPublicAppConfig() {
  const settings = await getConfig("system.settings", DEFAULT_SETTINGS);
  const { getOpsLimits, getOpsCutoffs } = await import(
    "../services/system-settings.js"
  );
  const support = {
    ...DEFAULT_SETTINGS.support,
    ...(settings as { support?: Partial<SystemSupportContacts> }).support,
  };
  const storedFlags =
    (settings as { flags?: { id: string; enabled?: boolean; label?: string; description?: string; audience?: string }[] })
      .flags ?? [];
  const flagsById = new Map(storedFlags.map((f) => [f.id, f]));
  /** Always resolve against the canonical flag catalogue so unknown/partial stores don't fail open. */
  const flagOn = (id: string) => {
    const hit = flagsById.get(id);
    if (hit && typeof hit.enabled === "boolean") return hit.enabled;
    return DEFAULT_SETTINGS.flags.find((f) => f.id === id)?.enabled ?? true;
  };
  const ops = await getOpsLimits();
  const cutoffs = await getOpsCutoffs();
  const { readMaintenanceState } = await import("../services/app-access.js");
  const maintenanceState = await readMaintenanceState();
  return {
    support: {
      phone: String(support.phone || "").trim(),
      whatsapp: String(support.whatsapp || "").replace(/\D/g, ""),
      email: String(support.email || "").trim(),
    },
    maintenance: {
      enabled: maintenanceState.enabled,
      message: maintenanceState.message,
      windowStart: maintenanceState.windowStart,
      windowEnd: maintenanceState.windowEnd,
    },
    featureFlags: {
      askAi: flagOn("ff-ai"),
      autoInvest: flagOn("ff-auto"),
      giftInvest: flagOn("ff-gift"),
      explore: flagOn("ff-explore"),
    },
    limits: {
      tier1DailyWithdrawal: ops.tier1DailyWithdrawal,
      tier2DailyWithdrawal: ops.tier2DailyWithdrawal,
      singlePayoutMax: ops.singlePayoutMax,
      minFixedPlacement: ops.minFixedPlacement,
      minCallDeposit: ops.minCallDeposit,
    },
    fees: {
      withdrawal: ops.withdrawalFee,
      cardFundingPct: ops.cardFundingPct,
    },
    cutoffs: {
      payoutBatch: cutoffs.payoutBatch,
      valueDate: cutoffs.valueDate,
      reconRun: cutoffs.reconRun,
      interestAccrual: cutoffs.interestAccrual,
    },
    /** Public Web OAuth client ID — safe to expose (not a secret). */
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || "",
  };
}

function mergeSettingsFlags(
  incoming:
    | {
        id: string;
        label: string;
        description: string;
        enabled: boolean;
        audience: string;
      }[]
    | undefined,
  current:
    | {
        id: string;
        label?: string;
        description?: string;
        enabled?: boolean;
        audience?: string;
      }[]
    | undefined,
) {
  const byId = new Map(DEFAULT_SETTINGS.flags.map((f) => [f.id, { ...f }]));
  for (const f of current ?? []) {
    const base = byId.get(f.id) ?? {
      id: f.id,
      label: f.label ?? f.id,
      description: f.description ?? "",
      enabled: true,
      audience: f.audience ?? "All customers",
    };
    byId.set(f.id, {
      ...base,
      ...f,
      id: f.id,
      enabled: typeof f.enabled === "boolean" ? f.enabled : base.enabled,
    });
  }
  for (const f of incoming ?? []) {
    const base = byId.get(f.id) ?? { ...f };
    byId.set(f.id, { ...base, ...f, id: f.id });
  }
  return DEFAULT_SETTINGS.flags.map((d) => byId.get(d.id)!);
}

function assertNonNegativeNumericRows(rows: { value: string; label?: string }[] | undefined, label: string) {
  if (!rows) return;
  for (const row of rows) {
    const n = Number(String(row.value).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      throw new AppError(400, `${label}: "${row.label ?? "value"}" must be a number ≥ 0`, "INVALID_SETTING");
    }
  }
}

function assertCutoffTimes(rows: { value: string; label?: string }[] | undefined) {
  if (!rows) return;
  for (const row of rows) {
    const v = String(row.value).trim();
    if (!/^\d{1,2}:\d{2}$/.test(v)) {
      throw new AppError(400, `Cut-offs: "${row.label ?? "value"}" must be HH:MM`, "INVALID_SETTING");
    }
    const [h, m] = v.split(":").map(Number);
    if ((h ?? 99) > 23 || (m ?? 99) > 59) {
      throw new AppError(400, `Cut-offs: "${row.label ?? "value"}" must be a valid time`, "INVALID_SETTING");
    }
  }
}

const DEFAULT_DIGEST = {
  enabled: true,
  sendTime: "07:30",
  audience: "seg-active",
  lastRun: null as string | null,
  deliveredYesterday: 0,
  openRate: 0,
};

const DEFAULT_REFERRAL_PROGRAMME = {
  enabled: true,
  requiresKyc: true,
  rules: {
    "rr-inviter": "5000",
    "rr-invitee": "2500",
    "rr-min": "50000",
    "rr-hold": "30",
    "rr-expiry": "30",
    "rr-cap": "10",
  } as Record<string, string>,
  changeLog: [] as { at: string; by: string; change: string; status: string }[],
  updatedAt: null as string | null,
  updatedBy: null as string | null,
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
    const { mergeSettingRows, DEFAULT_FEES, DEFAULT_LIMITS, DEFAULT_CUTOFFS } = await import(
      "../services/system-settings.js"
    );
    const stored = settings as typeof DEFAULT_SETTINGS;
    res.json({
      data: {
        ...DEFAULT_SETTINGS,
        ...stored,
        fees: mergeSettingRows(DEFAULT_FEES, stored.fees ?? DEFAULT_SETTINGS.fees),
        limits: mergeSettingRows(DEFAULT_LIMITS, stored.limits ?? DEFAULT_SETTINGS.limits),
        cutoffs: mergeSettingRows(DEFAULT_CUTOFFS, stored.cutoffs ?? DEFAULT_SETTINGS.cutoffs),
        flags: mergeSettingsFlags(undefined, stored.flags),
        support: {
          ...DEFAULT_SETTINGS.support,
          ...(stored as { support?: Partial<SystemSupportContacts> }).support,
        },
        maintenance: {
          ...DEFAULT_SETTINGS.maintenance,
          ...(stored as { maintenance?: object }).maintenance,
        },
      },
    });
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
        maintenance: z
          .object({
            enabled: z.boolean(),
            message: z.string(),
            windowStart: z.string().nullable().optional(),
            windowEnd: z.string().nullable().optional(),
          })
          .optional(),
        support: z
          .object({
            phone: z.string().max(32).optional(),
            whatsapp: z.string().max(32).optional(),
            email: z.string().max(120).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const current = await getConfig("system.settings", DEFAULT_SETTINGS);
    const currentSupport = {
      ...DEFAULT_SETTINGS.support,
      ...(current as { support?: Partial<SystemSupportContacts> }).support,
    };
    const nextSupport = body.support
      ? {
          phone: String(body.support.phone ?? currentSupport.phone).trim(),
          whatsapp: String(body.support.whatsapp ?? currentSupport.whatsapp).replace(/\D/g, ""),
          email: String(body.support.email ?? currentSupport.email).trim(),
        }
      : currentSupport;
    assertNonNegativeNumericRows(body.fees, "Fees");
    assertNonNegativeNumericRows(body.limits, "Limits");
    assertCutoffTimes(body.cutoffs);
    const { mergeSettingRows, DEFAULT_FEES, DEFAULT_LIMITS, DEFAULT_CUTOFFS } = await import(
      "../services/system-settings.js"
    );
    const next = {
      fees: mergeSettingRows(DEFAULT_FEES, body.fees ?? (current as { fees?: typeof DEFAULT_FEES }).fees),
      limits: mergeSettingRows(
        DEFAULT_LIMITS,
        body.limits ?? (current as { limits?: typeof DEFAULT_LIMITS }).limits,
      ),
      cutoffs: mergeSettingRows(
        DEFAULT_CUTOFFS,
        body.cutoffs ?? (current as { cutoffs?: typeof DEFAULT_CUTOFFS }).cutoffs,
      ),
      flags: mergeSettingsFlags(body.flags, (current as { flags?: typeof DEFAULT_SETTINGS.flags }).flags),
      maintenance: body.maintenance
        ? {
            enabled: body.maintenance.enabled,
            message: body.maintenance.message,
            windowStart:
              body.maintenance.windowStart === undefined
                ? (current as { maintenance?: { windowStart?: string | null } }).maintenance?.windowStart ??
                  null
                : body.maintenance.windowStart,
            windowEnd:
              body.maintenance.windowEnd === undefined
                ? (current as { maintenance?: { windowEnd?: string | null } }).maintenance?.windowEnd ?? null
                : body.maintenance.windowEnd,
          }
        : (current as { maintenance?: typeof DEFAULT_SETTINGS.maintenance }).maintenance ??
          DEFAULT_SETTINGS.maintenance,
      support: nextSupport,
    };
    if (next.maintenance.windowStart && next.maintenance.windowEnd) {
      const start = Date.parse(next.maintenance.windowStart);
      const end = Date.parse(next.maintenance.windowEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new AppError(400, "Maintenance window must be valid date/times", "INVALID_SETTING");
      }
      if (end < start) {
        throw new AppError(400, "Maintenance end must be after start", "INVALID_SETTING");
      }
    }
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

adminConsoleRouter.get(
  "/marketing/referrals",
  asyncHandler(async (_req, res) => {
    const programme = await getConfig("marketing.referral", DEFAULT_REFERRAL_PROGRAMME);
    res.json({
      data: {
        ...DEFAULT_REFERRAL_PROGRAMME,
        ...programme,
        rules: {
          ...DEFAULT_REFERRAL_PROGRAMME.rules,
          ...(programme.rules ?? {}),
        },
        changeLog: programme.changeLog ?? [],
      },
    });
  }),
);

adminConsoleRouter.put(
  "/marketing/referrals",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        enabled: z.boolean(),
        requiresKyc: z.boolean(),
        rules: z.object({
          "rr-inviter": z.string().regex(/^\d+$/),
          "rr-invitee": z.string().regex(/^\d+$/),
          "rr-min": z.string().regex(/^\d+$/),
          "rr-hold": z.string().regex(/^\d+$/),
          "rr-expiry": z.string().regex(/^\d+$/),
          "rr-cap": z.string().regex(/^\d+$/),
        }),
      })
      .parse(req.body);

    const asInt = (v: string, label: string, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new AppError(400, `${label} must be between ${min} and ${max}`, "INVALID_VALUE");
      }
      return n;
    };
    asInt(body.rules["rr-inviter"], "Inviter reward", 0, 1_000_000);
    asInt(body.rules["rr-invitee"], "Invitee reward", 0, 1_000_000);
    asInt(body.rules["rr-min"], "Qualifying funding", 0, 100_000_000);
    asInt(body.rules["rr-hold"], "Hold period", 0, 3650);
    asInt(body.rules["rr-expiry"], "Invite expiry", 1, 3650);
    asInt(body.rules["rr-cap"], "Monthly cap", 1, 1000);

    const current = await getConfig("marketing.referral", DEFAULT_REFERRAL_PROGRAMME);
    const prevRules = {
      ...DEFAULT_REFERRAL_PROGRAMME.rules,
      ...(current.rules ?? {}),
    };
    const changes: string[] = [];
    if (Boolean(current.enabled) !== body.enabled) {
      changes.push(`Programme ${body.enabled ? "enabled" : "disabled"}`);
    }
    if (Boolean(current.requiresKyc) !== body.requiresKyc) {
      changes.push(`Require KYC ${body.requiresKyc ? "on" : "off"}`);
    }
    for (const [id, nextVal] of Object.entries(body.rules)) {
      if (String(prevRules[id] ?? "") !== nextVal) {
        changes.push(`${id}: ${prevRules[id] ?? "—"} → ${nextVal}`);
      }
    }

    const nowIso = new Date().toISOString();
    const actor =
      (await prisma.adminUser.findUnique({ where: { id: req.adminId! }, select: { name: true } }))
        ?.name || "Admin";
    const entry = {
      at: nowIso,
      by: actor,
      change: changes.length ? changes.join("; ") : "No field changes",
      status: "saved",
    };
    const next = {
      ...DEFAULT_REFERRAL_PROGRAMME,
      ...current,
      enabled: body.enabled,
      requiresKyc: body.requiresKyc,
      rules: body.rules,
      updatedAt: nowIso,
      updatedBy: actor,
      changeLog: [entry, ...(current.changeLog ?? [])].slice(0, 50),
    };
    await setConfig("marketing.referral", next, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "referral.rules.updated",
      entityType: "AppConfig",
      entityId: "marketing.referral",
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
  {
    id: "rp-wht",
    name: "Withholding tax (WHT)",
    category: "Finance",
    description: "Interest gross, 10% WHT and net per client investment for the period.",
    formats: ["CSV"],
    cadence: "On demand",
    owner: "Finance",
  },
];

function customerLabel(user: {
  firstName: string;
  surname?: string | null;
  email?: string | null;
} | null | undefined) {
  if (!user) return { name: "", email: "" };
  const name = `${user.firstName ?? ""} ${user.surname ?? ""}`.trim();
  return { name, email: user.email ?? "" };
}

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
          lastRun: last?.startedAt
            ? formatReportDateTime(last.startedAt)
            : "Never",
          lastRunAt: last?.startedAt?.toISOString() ?? null,
        };
      }),
    );
    res.json({
      data: {
        packs,
        schedules: schedules.map((s) => ({
          ...s,
          next: s.next ? formatReportDate(s.next) : s.next,
        })),
        exports: exports.map((e) => ({
          id: e.id,
          name: e.jobName.replace(/^report\./, ""),
          status: e.status,
          at: e.startedAt.toISOString(),
          atDisplay: formatReportDateTime(e.startedAt),
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

async function buildWhtReport(
  from: Date,
  to: Date,
): Promise<{ headers: string[]; rows: string[][]; rowCount: number }> {
  const headers = [
    "Client",
    "Email",
    "Investment",
    "Event date",
    "Gross interest (₦)",
    "WHT (₦)",
    "Net interest (₦)",
  ];
  const rows: string[][] = [];
  let totalGross = 0;
  let totalWht = 0;
  let totalNet = 0;

  const interestEntries = await prisma.journalEntry.findMany({
    where: { kind: "INTEREST", createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  const placementIds = new Set<string>();
  for (const e of interestEntries) {
    const meta = e.metadata && typeof e.metadata === "object" ? (e.metadata as Record<string, unknown>) : {};
    if (typeof meta.placementId === "string") placementIds.add(meta.placementId);
  }

  const matured = await prisma.placement.findMany({
    where: {
      maturityDate: { gte: from, lte: to },
      status: { in: ["MATURED", "CLOSED"] },
    },
    include: {
      user: { select: { firstName: true, surname: true, email: true } },
    },
    take: 5000,
  });
  for (const p of matured) placementIds.add(p.id);

  const placements = placementIds.size
    ? await prisma.placement.findMany({
        where: { id: { in: [...placementIds] } },
        include: { user: { select: { firstName: true, surname: true, email: true } } },
      })
    : [];
  const placementById = Object.fromEntries(placements.map((p) => [p.id, p]));

  const pushRow = (input: {
    user: { firstName: string; surname?: string | null; email?: string | null };
    investment: string;
    eventDate: Date;
    netKobo: bigint;
    rateBps: number;
  }) => {
    const bd = interestBreakdownFromNetAmount(input.netKobo, input.rateBps);
    const gross = koboToNaira(bd.grossKobo);
    const wht = koboToNaira(bd.whtKobo);
    const net = koboToNaira(bd.netKobo);
    const { name, email } = customerLabel(input.user);
    rows.push([
      name,
      email,
      input.investment,
      formatReportDate(input.eventDate),
      gross.toFixed(2),
      wht.toFixed(2),
      net.toFixed(2),
    ]);
    totalGross += gross;
    totalWht += wht;
    totalNet += net;
  };

  const seenKeys = new Set<string>();

  for (const e of interestEntries) {
    const meta = e.metadata && typeof e.metadata === "object" ? (e.metadata as Record<string, unknown>) : {};
    const placementId = typeof meta.placementId === "string" ? meta.placementId : null;
    let netKobo =
      typeof meta.netKobo === "string"
        ? BigInt(meta.netKobo)
        : typeof meta.netKobo === "number"
          ? BigInt(Math.trunc(meta.netKobo))
          : 0n;
    if (netKobo <= 0n) {
      const creditLine = await prisma.journalLine.findFirst({
        where: { entryId: e.id, amountKobo: { gt: 0 } },
        select: { amountKobo: true },
      });
      netKobo = creditLine?.amountKobo ?? 0n;
    }
    if (netKobo <= 0n) continue;

    const placement = placementId ? placementById[placementId] : null;
    const investment =
      placement != null
        ? placement.kind === "FIXED"
          ? displayPlanName(placement.planType ?? "LOCK", placement.tenorDays)
          : placement.name
        : e.description?.trim() || "Call / other interest";
    const user =
      placement?.user ??
      (await prisma.journalLine
        .findFirst({
          where: { entryId: e.id, account: { userId: { not: null } } },
          include: {
            account: {
              include: {
                user: { select: { firstName: true, surname: true, email: true } },
              },
            },
          },
        })
        .then((l) => l?.account.user)) ?? {
        firstName: "Customer",
        surname: "",
        email: "",
      };
    const rateBps = placement?.rateBps ?? 0;
    const key = `je:${e.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    pushRow({
      user,
      investment,
      eventDate: e.createdAt,
      netKobo,
      rateBps,
    });
  }

  for (const p of matured) {
    const key = `mat:${p.id}`;
    if (seenKeys.has(key)) continue;
    const netKobo =
      p.accruedKobo > 0n
        ? p.accruedKobo
        : p.tenorDays != null
          ? interestBreakdownFromNetRate(p.principalKobo, p.rateBps, p.tenorDays).netKobo
          : 0n;
    if (netKobo <= 0n) continue;
    seenKeys.add(key);
    const label =
      p.kind === "FIXED" ? displayPlanName(p.planType ?? "LOCK", p.tenorDays) : p.name;
    pushRow({
      user: p.user,
      investment: label,
      eventDate: p.maturityDate ?? p.startDate,
      netKobo,
      rateBps: p.rateBps,
    });
  }

  if (rows.length) {
    rows.push([
      "Totals",
      "",
      "",
      "",
      totalGross.toFixed(2),
      totalWht.toFixed(2),
      totalNet.toFixed(2),
    ]);
  }

  return { headers, rows, rowCount: rows.length };
}

async function buildReportExport(
  packId: string,
  from: Date,
  to: Date,
): Promise<{ headers: string[]; rows: string[][]; rowCount: number }> {
  const at = (d: Date) => formatReportDateTime(d);
  if (packId === "rp-wht") {
    return buildWhtReport(from, to);
  }
  if (packId === "rp-ledger") {
    const headers = ["Client", "Email", "Reference", "Kind", "Description", "Created at"];
    const entries = await prisma.journalEntry.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      take: 5000,
      include: {
        lines: {
          take: 8,
          include: {
            account: {
              include: {
                user: { select: { firstName: true, surname: true, email: true } },
              },
            },
          },
        },
      },
    });
    const rows = entries.map((e) => {
      const userLine = e.lines.find((l) => l.account.user)?.account.user;
      const { name, email } = customerLabel(userLine);
      return [name, email, e.reference, e.kind, e.description ?? "", at(e.createdAt)];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-withdrawals") {
    const headers = ["Client", "Email", "Reference", "Amount (₦)", "Status", "Created at"];
    const items = await prisma.withdrawalRequest.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      take: 5000,
      include: { user: { select: { firstName: true, surname: true, email: true } } },
    });
    const rows = items.map((w) => {
      const { name, email } = customerLabel(w.user);
      return [
        name,
        email,
        w.reference,
        koboToNaira(w.amountKobo).toFixed(2),
        w.status,
        at(w.createdAt),
      ];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-support") {
    const headers = ["Client", "Email", "Ticket", "Category", "Subject", "Status", "Created at"];
    const items = await prisma.supportTicket.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      take: 5000,
      include: { user: { select: { firstName: true, surname: true, email: true } } },
    });
    const rows = items.map((t) => {
      const { name, email } = customerLabel(t.user);
      return [name, email, t.id, t.category, t.subject, t.status, at(t.createdAt)];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-audit") {
    const headers = ["ID", "Action", "Entity type", "Entity ID", "Actor admin", "IP", "Created at"];
    const items = await prisma.auditEvent.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });
    const rows = items.map((e) => [
      e.id,
      e.action,
      e.entityType ?? "",
      e.entityId ?? "",
      e.actorAdminId ?? "",
      e.ipAddress ?? "",
      at(e.createdAt),
    ]);
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-ai") {
    const headers = ["Client", "Email", "Session ID", "Messages", "Flagged", "Created at"];
    const sessions = await prisma.chatSession.findMany({
      where: { createdAt: { gte: from, lte: to } },
      include: {
        _count: { select: { messages: true } },
        user: { select: { firstName: true, surname: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });
    const rows = sessions.map((s) => {
      const { name, email } = customerLabel(s.user);
      return [name, email, s.id, String(s._count.messages), s.flagged ? "yes" : "no", at(s.createdAt)];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-kyc") {
    const headers = ["Client", "Email", "User ID", "KYC tier", "Frozen", "Joined"];
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      take: 5000,
      select: {
        id: true,
        firstName: true,
        surname: true,
        email: true,
        kycTier: true,
        frozen: true,
        createdAt: true,
      },
    });
    const rows = users.map((u) => {
      const { name, email } = customerLabel(u);
      return [name, email, u.id, u.kycTier, u.frozen ? "yes" : "no", formatReportDate(u.createdAt)];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-growth") {
    const headers = ["Client", "Email", "User ID", "Joined"];
    const users = await prisma.user.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      take: 5000,
      select: { id: true, firstName: true, surname: true, email: true, createdAt: true },
    });
    const rows = users.map((u) => {
      const { name, email } = customerLabel(u);
      return [name, email, u.id, formatReportDate(u.createdAt)];
    });
    return { headers, rows, rowCount: rows.length };
  }
  if (packId === "rp-fum") {
    const headers = [
      "Client",
      "Email",
      "Placement ID",
      "Kind",
      "Plan",
      "Principal (₦)",
      "Value at maturity (₦)",
      "Status",
    ];
    const placements = await prisma.placement.findMany({
      where: { status: "ACTIVE" },
      take: 5000,
      include: { user: { select: { firstName: true, surname: true, email: true } } },
    });
    const rows = placements.map((p) => {
      const { name, email } = customerLabel(p.user);
      const plan =
        p.kind === "FIXED" ? displayPlanName(p.planType ?? "LOCK", p.tenorDays) : p.name;
      const expected =
        p.tenorDays != null
          ? interestBreakdownFromNetRate(p.principalKobo, p.rateBps, p.tenorDays)
          : null;
      const valueAtMaturity =
        p.interestPayout === "UPFRONT"
          ? p.principalKobo
          : expected
            ? p.principalKobo + expected.netKobo
            : p.principalKobo;
      return [
        name,
        email,
        p.id,
        p.kind,
        plan,
        koboToNaira(p.principalKobo).toFixed(2),
        koboToNaira(valueAtMaturity).toFixed(2),
        p.status,
      ];
    });
    return { headers, rows, rowCount: rows.length };
  }
  return { headers: ["Note"], rows: [["No export rows for this pack"]], rowCount: 0 };
}

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
    if (from.getTime() > to.getTime()) {
      throw new AppError(400, "From date must be on or before To date", "INVALID_RANGE");
    }

    const { headers, rows, rowCount } = await buildReportExport(pack.id, from, to);

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
        headers,
        rows,
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

adminConsoleRouter.get(
  "/role-permissions",
  asyncHandler(async (_req, res) => {
    const stored = await getConfig("admin.rolePermissions", null as Record<string, string[]> | null);
    res.json({ data: stored ?? {} });
  }),
);

adminConsoleRouter.put(
  "/role-permissions",
  asyncHandler(async (req: AdminRequest, res) => {
    const { assertAdminPermission } = await import("../services/admin-permissions.js");
    await assertAdminPermission(req.adminRole, "role.manage");
    const body = z.record(z.string(), z.array(z.string())).parse(req.body);
    await setConfig("admin.rolePermissions", body, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "roles.permissions_updated",
      entityType: "AppConfig",
      entityId: "admin.rolePermissions",
    });
    res.json({ data: body });
  }),
);

adminConsoleRouter.get(
  "/marketing/audience/count",
  asyncHandler(async (_req, res) => {
    const [total, activeInvestors, neverInvested, tier0, maturingSoon] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: { placements: { some: { status: "ACTIVE" } } },
      }),
      prisma.user.count({
        where: { placements: { none: {} } },
      }),
      prisma.user.count({ where: { kycTier: "TIER_0" } }),
      prisma.user.count({
        where: {
          placements: {
            some: {
              status: "ACTIVE",
              maturityDate: {
                gte: new Date(),
                lte: new Date(Date.now() + 7 * 86400000),
              },
            },
          },
        },
      }),
    ]);
    const idleCash = Math.max(0, total - activeInvestors);
    res.json({
      data: {
        total,
        segments: {
          "All customers": total,
          "Active investors": activeInvestors,
          "Idle cash holders": idleCash,
          "Unverified signups": tier0,
          "Maturing in 7 days": maturingSoon,
          "Never invested": neverInvested,
        },
      },
    });
  }),
);

adminConsoleRouter.get(
  "/marketing/audience/filters",
  asyncHandler(async (_req, res) => {
    const filters = await getConfig("marketing.audienceFilters", {
      tier: "Any tier",
      status: "Any",
      kind: "All customers",
      minBalance: "",
    });
    res.json({ data: filters });
  }),
);

adminConsoleRouter.put(
  "/marketing/audience/filters",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        tier: z.string(),
        status: z.string(),
        kind: z.string(),
        minBalance: z.string(),
      })
      .parse(req.body);
    await setConfig("marketing.audienceFilters", body, req.adminId);
    res.json({ data: body });
  }),
);

adminConsoleRouter.post(
  "/marketing/digest/send-now",
  asyncHandler(async (req: AdminRequest, res) => {
    const { runMarketingDigestJob } = await import("../jobs/marketing-digest.js");
    const result = await runMarketingDigestJob({ manual: true, adminId: req.adminId });
    res.status(201).json({ data: result });
  }),
);

/** Managed emails for withdrawal-request ops alerts (platform or external). */
adminConsoleRouter.get(
  "/settings/withdrawal-notify-emails",
  asyncHandler(async (_req, res) => {
    const {
      listWithdrawalNotifyEmails,
      listWithdrawalNotifyActivity,
    } = await import("../services/withdrawal-notify-emails.js");
    const [emails, activity] = await Promise.all([
      listWithdrawalNotifyEmails(),
      listWithdrawalNotifyActivity(100),
    ]);
    res.json({ data: { emails, activity } });
  }),
);

adminConsoleRouter.post(
  "/settings/withdrawal-notify-emails",
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        email: z.string().min(3).max(160),
        label: z.string().max(80).optional(),
      })
      .parse(req.body);
    const { addWithdrawalNotifyEmail } = await import(
      "../services/withdrawal-notify-emails.js"
    );
    const row = await addWithdrawalNotifyEmail({
      email: body.email,
      label: body.label,
      adminId: req.adminId,
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "settings.withdrawal_notify_email.added",
      entityType: "AppConfig",
      entityId: row.id,
      after: { email: row.email },
    }).catch(() => undefined);
    res.status(201).json({ data: row });
  }),
);

adminConsoleRouter.patch(
  "/settings/withdrawal-notify-emails/:id",
  asyncHandler(async (req: AdminRequest, res) => {
    const id = String(req.params.id || "");
    const body = z
      .object({
        active: z.boolean().optional(),
        label: z.string().max(80).optional(),
      })
      .parse(req.body);
    const { updateWithdrawalNotifyEmail } = await import(
      "../services/withdrawal-notify-emails.js"
    );
    const row = await updateWithdrawalNotifyEmail(id, body, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "settings.withdrawal_notify_email.updated",
      entityType: "AppConfig",
      entityId: row.id,
      after: { email: row.email, active: row.active },
    }).catch(() => undefined);
    res.json({ data: row });
  }),
);

adminConsoleRouter.delete(
  "/settings/withdrawal-notify-emails/:id",
  asyncHandler(async (req: AdminRequest, res) => {
    const id = String(req.params.id || "");
    const { removeWithdrawalNotifyEmail } = await import(
      "../services/withdrawal-notify-emails.js"
    );
    await removeWithdrawalNotifyEmail(id, req.adminId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "settings.withdrawal_notify_email.removed",
      entityType: "AppConfig",
      entityId: id,
    }).catch(() => undefined);
    res.json({ data: { ok: true } });
  }),
);
