import {
  creditWalletFrom,
  debitWallet,
  ensureSystemAccount,
  ensureUserCall,
  ensureUserWallet,
  accruedInterestToDateKobo,
  interestForPeriod,
  placementInterestKobo,
} from "../services/money.js";
import { asyncHandler, AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { hashSecret, verifySecret, koboToNaira, nairaToKobo, makeReferralCode } from "../lib/crypto.js";
import { adminReviewKyc, getKycStatus } from "../services/kyc.js";
import { writeAudit } from "../services/audit.js";
import {
  requireAdmin,
  requirePermission,
  requireRoles,
  canViewAum,
  type AdminRequest,
} from "../middleware/admin.js";
import { buildMaturityTracker } from "../services/maturity-tracker.js";

/** True SUPER role only — GLOBAL is not treated as super for privileged overrides. */
function assertSuperAdmin(req: AdminRequest) {
  if (req.adminRole !== "SUPER") {
    throw new AppError(403, "Super admin only", "FORBIDDEN");
  }
}

/** Derive stored rate from principal + tenor + interest (simple interest). */
function rateBpsFromInterest(principalKobo: bigint, tenorDays: number, interestKobo: bigint): number {
  if (principalKobo <= 0n || tenorDays <= 0 || interestKobo < 0n) return 0;
  return Number((interestKobo * 1_000_000n * 365n) / (principalKobo * BigInt(tenorDays)));
}

function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

function placementDisplayStatus(
  p: Pick<Placement, "status" | "breakRequestedAt" | "breakCreditAt">,
): "active" | "matured" | "broken" | "break pending" {
  if (p.status === "MATURED") return "matured";
  if (p.status === "CLOSED" && p.breakRequestedAt) return "broken";
  if (p.status === "CLOSED") return "matured";
  if (p.status === "ACTIVE" && p.breakRequestedAt) return "break pending";
  return "active";
}

function serializeAdminPlacement(
  p: Placement,
  client?: { id: string; name: string; email: string | null },
) {
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
    userId: p.userId,
    client: client ?? null,
    name: displayName,
    rawName: p.name,
    kind: p.kind,
    planType,
    interestPayout: payout,
    status: placementDisplayStatus(p),
    statusRaw: p.status,
    principal: koboToNaira(p.principalKobo),
    ratePct: pair.netRatePct,
    grossRatePct: pair.grossRatePct,
    rateLabel: pair.label,
    tenorDays: p.tenorDays,
    startDate: p.startDate.toISOString().slice(0, 10),
    maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
    placedAt: p.createdAt.toISOString(),
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
    breakRequestedAt: p.breakRequestedAt?.toISOString() ?? null,
    productId: p.productId,
    interestOverride: p.interestOverrideKobo != null,
    createdAt: p.createdAt,
  };
}
import { listSignupDropoffs } from "../services/signup-funnel.js";
import {
  sendWelcomeEmail,
  sendCustomerPasswordResetEmail,
  notifyCustomer,
  createUserNotification,
  notifyAccountAccessChange,
  sendAdminInviteEmail,
  sendTicketAssignedEmail,
  sendProfileUpdatedEmail,
} from "../services/notify.js";
import {
  displayPlanName,
  PLAN_MIN_NAIRA,
  resolvePlanRate,
} from "../services/lock-flex-rates.js";
import {
  formatRatePair,
  interestBreakdownFromNetAmount,
  interestBreakdownFromNetRate,
} from "../services/wht.js";
import { requestOtp, verifyOtp } from "../services/auth.js";
import { productDetailsSchema, toPrismaJson, asProductDetails } from "../lib/product-details.js";
import { serializePlacementHolding } from "../services/placement-display.js";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Router } from "express";
import { nanoid } from "nanoid";
import type { Placement, Prisma } from "@prisma/client";

async function userBalances(userId: string) {
  const wallet = await ensureUserWallet(userId);
  const call = await ensureUserCall(userId);
  const placements = await prisma.placement.findMany({
    where: { userId, status: "ACTIVE" },
  });
  let fixed = 0n;
  let explore = 0n;
  let accrued = 0n;
  for (const p of placements) {
    const earned = accruedInterestToDateKobo(p);
    accrued += earned;
    const mark = p.principalKobo + earned;
    if (p.kind === "EXPLORE") explore += mark;
    else if (p.kind === "FIXED") fixed += mark;
  }
  return {
    wallet: koboToNaira(wallet.balanceKobo),
    call: koboToNaira(call.balanceKobo),
    fixed: koboToNaira(fixed),
    explore: koboToNaira(explore),
    /** Sum of accrued interest across active placements (also included in fixed/explore). */
    accrued: koboToNaira(accrued),
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

const adminRoleSchema = z.enum([
  "SUPER",
  "GLOBAL",
  "COMPLIANCE",
  "OPERATIONS",
  "MARKETING",
  "FINANCE",
  "SUPPORT",
  "READ_ONLY",
]);

function assertAdminPasswordRules(password: string) {
  if (password.length < 12) {
    throw new AppError(400, "Password must be at least 12 characters", "PASSWORD_WEAK");
  }
  if (!/\d/.test(password)) {
    throw new AppError(400, "Password must include a number", "PASSWORD_WEAK");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new AppError(400, "Password must include a symbol", "PASSWORD_WEAK");
  }
}

export const adminRouter = Router();

adminRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);
    const admin = await prisma.adminUser.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!admin || !admin.active || !(await verifySecret(body.password, admin.passwordHash))) {
      throw new AppError(401, "Invalid credentials", "AUTH_FAILED");
    }

    // Authenticator TOTP when enrolled.
    if (admin.totpEnabled && admin.totpSecretEnc) {
      const mfaToken = jwt.sign(
        { sub: admin.id, email: admin.email, typ: "admin_mfa", method: "totp" },
        env.JWT_ACCESS_SECRET,
        { expiresIn: "10m" },
      );
      return res.json({
        data: {
          mfaRequired: true,
          mfaMethod: "totp",
          mfaToken,
          admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        },
      });
    }

    const session = await prisma.adminSession.create({
      data: { adminId: admin.id, refreshTokenHash: "admin" },
    });
    const accessToken = jwt.sign(
      { sub: admin.id, sid: session.id, typ: "admin", role: admin.role },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "8h" },
    );

    if (admin.invitePending) {
      await prisma.adminUser.update({
        where: { id: admin.id },
        data: { invitePending: false },
      });
    }

    await writeAudit({
      actorAdminId: admin.id,
      action: "admin.login",
      entityType: "AdminUser",
      entityId: admin.id,
    });

    res.json({
      data: {
        mfaRequired: false,
        accessToken,
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        totpEnabled: admin.totpEnabled,
      },
    });
  }),
);

adminRouter.post(
  "/login/otp",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        mfaToken: z.string().min(10),
        code: z.string().min(4).max(8),
      })
      .parse(req.body);

    let payload: { sub?: string; typ?: string; email?: string; method?: string };
    try {
      payload = jwt.verify(body.mfaToken, env.JWT_ACCESS_SECRET) as {
        sub?: string;
        typ?: string;
        email?: string;
        method?: string;
      };
    } catch {
      throw new AppError(401, "MFA session expired. Sign in again.", "MFA_EXPIRED");
    }
    if (payload.typ !== "admin_mfa" || !payload.sub || !payload.email) {
      throw new AppError(401, "Invalid MFA token", "MFA_INVALID");
    }

    const admin = await prisma.adminUser.findFirst({
      where: { id: payload.sub, active: true },
    });
    if (!admin) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    if (payload.method === "totp" || (admin.totpEnabled && admin.totpSecretEnc)) {
      if (!admin.totpSecretEnc) {
        throw new AppError(400, "Authenticator is not set up for this account", "TOTP_MISSING");
      }
      const { decryptTotpSecret, verifyTotpCode } = await import("../services/admin-totp.js");
      let secret: string;
      try {
        secret = decryptTotpSecret(admin.totpSecretEnc);
      } catch {
        throw new AppError(500, "Could not verify authenticator", "TOTP_CORRUPT");
      }
      if (!verifyTotpCode(secret, body.code.trim())) {
        throw new AppError(401, "Invalid authenticator code", "TOTP_INVALID");
      }
    } else {
      await verifyOtp({
        target: admin.email,
        purpose: "ADMIN_LOGIN",
        code: body.code.trim(),
      });
    }

    const session = await prisma.adminSession.create({
      data: { adminId: admin.id, refreshTokenHash: "admin" },
    });
    const accessToken = jwt.sign(
      { sub: admin.id, sid: session.id, typ: "admin", role: admin.role },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "8h" },
    );

    await writeAudit({
      actorAdminId: admin.id,
      action: "admin.login",
      entityType: "AdminUser",
      entityId: admin.id,
    });

    res.json({
      data: {
        accessToken,
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      },
    });
  }),
);

adminRouter.post(
  "/login/otp/resend",
  asyncHandler(async (req, res) => {
    const body = z.object({ mfaToken: z.string().min(10) }).parse(req.body);
    let payload: { sub?: string; typ?: string; email?: string; method?: string };
    try {
      payload = jwt.verify(body.mfaToken, env.JWT_ACCESS_SECRET) as {
        sub?: string;
        typ?: string;
        email?: string;
        method?: string;
      };
    } catch {
      throw new AppError(401, "MFA session expired. Sign in again.", "MFA_EXPIRED");
    }
    if (payload.typ !== "admin_mfa" || !payload.sub) {
      throw new AppError(401, "Invalid MFA token", "MFA_INVALID");
    }
    if (payload.method === "totp") {
      throw new AppError(
        400,
        "Open Google Authenticator (or your authenticator app) for a new code — email resend is not used.",
        "TOTP_NO_RESEND",
      );
    }
    const admin = await prisma.adminUser.findFirst({
      where: { id: payload.sub, active: true },
    });
    if (!admin) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    const otp = await requestOtp({
      target: admin.email,
      purpose: "ADMIN_LOGIN",
    });

    res.json({
      data: {
        sent: true,
        ...(otp.debugCode ? { debugCode: otp.debugCode } : {}),
      },
    });
  }),
);

adminRouter.post(
  "/session/unlock",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z.object({ pin: z.string().length(4) }).parse(req.body);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    if (!admin.pinHash) {
      throw new AppError(400, "Unlock PIN is not set for this account", "PIN_MISSING");
    }
    const ok = await verifySecret(body.pin, admin.pinHash);
    if (!ok) throw new AppError(401, "Incorrect PIN", "PIN_INVALID");
    res.json({ data: { unlocked: true } });
  }),
);

/** Set or reset the idle-lock Quick PIN (requires console password). */
adminRouter.post(
  "/session/pin",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        password: z.string().min(1),
        pin: z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
        confirmPin: z.string().length(4),
      })
      .parse(req.body);

    if (body.pin !== body.confirmPin) {
      throw new AppError(400, "PIN confirmation does not match", "PIN_MISMATCH");
    }

    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    const passwordOk = await verifySecret(body.password, admin.passwordHash);
    if (!passwordOk) {
      throw new AppError(401, "Incorrect console password", "PASSWORD_INVALID");
    }

    const hadPin = Boolean(admin.pinHash);
    const pinHash = await hashSecret(body.pin);
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { pinHash },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: hadPin ? "admin.pin.reset" : "admin.pin.set",
      entityType: "AdminUser",
      entityId: admin.id,
    });

    res.json({ data: { ok: true, hasPin: true } });
  }),
);

adminRouter.get(
  "/session/pin",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { id: req.adminId! },
      select: { pinHash: true },
    });
    res.json({ data: { hasPin: Boolean(admin.pinHash) } });
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
  requirePermission("dashboard.view"),
  asyncHandler(async (req: AdminRequest, res) => {
    const wallets = await prisma.ledgerAccount.aggregate({
      where: { type: "USER_WALLET" },
      _sum: { balanceKobo: true },
    });
    const call = await prisma.ledgerAccount.aggregate({
      where: { type: "USER_CALL" },
      _sum: { balanceKobo: true },
    });
    const activePlacements = await prisma.placement.findMany({
      where: { status: "ACTIVE" },
      include: {
        product: { include: { category: true } },
        user: { select: { firstName: true, surname: true, email: true } },
      },
    });

    const tracker = buildMaturityTracker(activePlacements);

    let fixedPrincipal = 0n;
    let explorePrincipal = 0n;
    let lockPrincipal = 0n;
    let flexPrincipal = 0n;
    let lockUpfrontPrincipal = 0n;
    let lockMaturityPrincipal = 0n;
    let interestAccruedKobo = 0n;
    let accruedGrossKobo = 0n;
    let accruedWhtKobo = 0n;

    const taxByCategory = new Map<
      string,
      { principal: bigint; accruedGross: bigint; accruedWht: bigint; accruedNet: bigint }
    >();

    for (const p of activePlacements) {
      if (p.kind === "EXPLORE") explorePrincipal += p.principalKobo;
      else if (p.kind === "FIXED") fixedPrincipal += p.principalKobo;

      if (p.kind === "FIXED" || p.kind === "EXPLORE") {
        const planType = p.planType ?? (p.kind === "FIXED" ? "LOCK" : null);
        const payout = p.interestPayout ?? "AT_MATURITY";
        if (planType === "LOCK") {
          lockPrincipal += p.principalKobo;
          if (payout === "UPFRONT") lockUpfrontPrincipal += p.principalKobo;
          else lockMaturityPrincipal += p.principalKobo;
        } else if (planType === "FLEX") {
          flexPrincipal += p.principalKobo;
        }

        const accrued = accruedInterestToDateKobo(p);
        const accruedBd = interestBreakdownFromNetAmount(accrued, p.rateBps);
        interestAccruedKobo += accrued;
        accruedGrossKobo += accruedBd.grossKobo;
        accruedWhtKobo += accruedBd.whtKobo;

        const cat =
          p.kind === "EXPLORE"
            ? p.product?.category?.name ?? "Explore"
            : planType === "FLEX"
              ? "Kipit Flex"
              : "Kipit Lock";
        const bucket = taxByCategory.get(cat) ?? {
          principal: 0n,
          accruedGross: 0n,
          accruedWht: 0n,
          accruedNet: 0n,
        };
        bucket.principal += p.principalKobo;
        bucket.accruedGross += accruedBd.grossKobo;
        bucket.accruedWht += accruedBd.whtKobo;
        bucket.accruedNet += accruedBd.netKobo;
        taxByCategory.set(cat, bucket);
      }
    }

    // C7 — Call Account principal on tax breakdown (interest accrues separately on call balances).
    const callKoboBal = call._sum.balanceKobo ?? 0n;
    if (callKoboBal > 0n || !taxByCategory.has("Call Account")) {
      const callBucket = taxByCategory.get("Call Account") ?? {
        principal: 0n,
        accruedGross: 0n,
        accruedWht: 0n,
        accruedNet: 0n,
      };
      callBucket.principal = callKoboBal;
      taxByCategory.set("Call Account", callBucket);
    }

    const walletKobo = wallets._sum.balanceKobo ?? 0n;
    const callKobo = callKoboBal;
    const principalKobo = walletKobo + callKobo + fixedPrincipal + explorePrincipal;
    const fumKobo = principalKobo + interestAccruedKobo;
    const users = await prisma.user.count();
    const pendingKyc = await prisma.kycProfile.count({ where: { status: "PENDING_REVIEW" } });
    const pendingWithdrawals = await prisma.withdrawalRequest.count({
      where: { status: "PROCESSING" },
    });
    const recentAudit = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    const showAum = canViewAum(req.adminRole);

    // Tracker VAM uses the same placementExpectedBreakdown path as client app/statement.
    const valueAtMaturityKobo = BigInt(
      Math.round((tracker.totals.valueAtMaturity ?? 0) * 100),
    );

    res.json({
      data: {
        fum: showAum ? koboToNaira(fumKobo) : null,
        principal: showAum ? koboToNaira(principalKobo) : null,
        canViewAum: showAum,
        users,
        pendingKyc,
        pendingWithdrawals,
        interestAccrued: showAum ? koboToNaira(interestAccruedKobo) : 0,
        interestPayable: showAum ? tracker.interestPayable.total : 0,
        recentAudit,
        breakdown: showAum
          ? {
              wallet: koboToNaira(walletKobo),
              call: koboToNaira(callKobo),
              fixed: koboToNaira(fixedPrincipal),
              explore: koboToNaira(explorePrincipal),
              placements: koboToNaira(fixedPrincipal + explorePrincipal),
              accrued: koboToNaira(interestAccruedKobo),
              lock: koboToNaira(lockPrincipal),
              flex: koboToNaira(flexPrincipal),
              lockUpfront: koboToNaira(lockUpfrontPrincipal),
              lockAtMaturity: koboToNaira(lockMaturityPrincipal),
              valueAtMaturity: tracker.totals.valueAtMaturity,
              byPlan: tracker.byPlan,
              byPayout: tracker.byPayout,
            }
          : null,
        tax: showAum
          ? {
              accruedGross: koboToNaira(accruedGrossKobo),
              accruedWht: koboToNaira(accruedWhtKobo),
              accruedNet: koboToNaira(interestAccruedKobo),
              expectedGross: tracker.totals.interestGross,
              expectedWht: tracker.totals.interestWht,
              expectedNet: tracker.totals.interestNet,
              byCategory: [...taxByCategory.entries()].map(([category, b]) => ({
                category,
                principal: koboToNaira(b.principal),
                accruedGross: koboToNaira(b.accruedGross),
                accruedWht: koboToNaira(b.accruedWht),
                accruedNet: koboToNaira(b.accruedNet),
              })),
              byProduct: tracker.taxByProduct,
            }
          : null,
        pendingFlexBreaks: tracker.pendingFlexBreaks.items.map((p) => ({
          id: p.id,
          userId: activePlacements.find((x) => x.id === p.id)?.userId ?? "",
          user: p.client ?? "—",
          email: activePlacements.find((x) => x.id === p.id)?.user?.email ?? null,
          principal: p.principal,
          creditNet: p.creditNet,
          payout: p.payout,
          breakRequestedAt: p.breakRequestedAt,
          breakCreditAt: p.creditDueAt,
          businessDaysLeft: p.businessDaysLeft,
          overdue: p.overdue,
        })),
        maturityTracker: showAum ? tracker : null,
        valueAtMaturityBook: showAum ? koboToNaira(valueAtMaturityKobo) : null,
      },
    });
  }),
);

adminRouter.get(
  "/users",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "all";
    const tierRaw = typeof req.query.tier === "string" ? req.query.tier.trim() : "all";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const dormantCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const and: Prisma.UserWhereInput[] = [];
    if (q) {
      and.push({
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { firstName: { contains: q, mode: "insensitive" } },
          { surname: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
          { id: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    if (tierRaw === "0" || tierRaw === "1" || tierRaw === "2") {
      and.push({ kycTier: `TIER_${tierRaw}` });
    }

    if (statusRaw === "frozen") {
      and.push({ frozen: true });
    } else if (statusRaw === "pending") {
      and.push({ frozen: false });
      and.push({
        OR: [{ kycTier: "TIER_0" }, { kycProfile: { is: { status: "PENDING_REVIEW" } } }],
      });
    } else if (statusRaw === "active") {
      and.push({ frozen: false });
      and.push({ kycTier: { not: "TIER_0" } });
      and.push({
        OR: [
          { kycProfile: { is: null } },
          { kycProfile: { isNot: { status: "PENDING_REVIEW" } } },
        ],
      });
      and.push({
        OR: [
          { sessions: { some: { revokedAt: null, lastActiveAt: { gte: dormantCutoff } } } },
          {
            AND: [
              { sessions: { none: { revokedAt: null } } },
              { updatedAt: { gte: dormantCutoff } },
            ],
          },
        ],
      });
    } else if (statusRaw === "dormant") {
      and.push({ frozen: false });
      and.push({
        sessions: { none: { revokedAt: null, lastActiveAt: { gte: dormantCutoff } } },
      });
      and.push({
        OR: [
          { sessions: { some: { revokedAt: null, lastActiveAt: { lt: dormantCutoff } } } },
          {
            AND: [
              { sessions: { none: { revokedAt: null } } },
              { updatedAt: { lt: dormantCutoff } },
            ],
          },
        ],
      });
    }

    const where: Prisma.UserWhereInput | undefined = and.length ? { AND: and } : undefined;
    const skip = (page - 1) * pageSize;

    const [total, users, summaryUsers, summaryVerified, summaryPending] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          ledgerAccounts: true,
          placements: { where: { status: "ACTIVE" } },
          sessions: { where: { revokedAt: null }, orderBy: { lastActiveAt: "desc" }, take: 1 },
          kycProfile: true,
        },
      }),
      prisma.user.count(),
      prisma.user.count({ where: { kycTier: "TIER_2" } }),
      prisma.user.count({
        where: {
          frozen: false,
          OR: [{ kycTier: "TIER_0" }, { kycProfile: { is: { status: "PENDING_REVIEW" } } }],
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let summaryAum: number | null = null;
    if (canViewAum(req.adminRole)) {
      const [wallets, call, placements] = await Promise.all([
        prisma.ledgerAccount.aggregate({
          where: { type: "USER_WALLET" },
          _sum: { balanceKobo: true },
        }),
        prisma.ledgerAccount.aggregate({
          where: { type: "USER_CALL" },
          _sum: { balanceKobo: true },
        }),
        prisma.placement.aggregate({
          where: { status: "ACTIVE" },
          _sum: { principalKobo: true },
        }),
      ]);
      summaryAum = koboToNaira(
        (wallets._sum.balanceKobo ?? 0n) +
          (call._sum.balanceKobo ?? 0n) +
          (placements._sum.principalKobo ?? 0n),
      );
    }

    res.json({
      data: {
        users: users.map((u) => {
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
          const inactive = last.getTime() < dormantCutoff.getTime();
          const status = u.frozen
            ? "frozen"
            : u.kycProfile?.status === "PENDING_REVIEW" || u.kycTier === "TIER_0"
              ? "pending"
              : inactive
                ? "dormant"
                : "active";
          return {
            id: u.id,
            email: u.email,
            phone: u.phone,
            name: `${u.firstName} ${u.surname}`,
            accountType: u.accountType,
            businessName: u.businessName,
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
        meta: {
          page,
          pageSize,
          total,
          totalPages,
          summary: {
            users: summaryUsers,
            verified: summaryVerified,
            pending: summaryPending,
            aum: summaryAum,
          },
        },
      },
    });
  }),
);

adminRouter.post(
  "/users",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        accountType: z.enum(["PERSONAL", "BUSINESS"]).default("PERSONAL"),
        email: z.string().email(),
        phone: z.string().optional(),
        firstName: z.string().min(1),
        middleName: z.string().optional(),
        surname: z.string().min(1),
        businessName: z.string().optional(),
        businessRcNumber: z.string().optional(),
        password: z.string().min(8).optional(),
        kycTier: z.enum(["TIER_0", "TIER_1", "TIER_2"]).optional(),
      })
      .parse(req.body);

    if (body.accountType === "BUSINESS" && !body.businessName?.trim()) {
      throw new AppError(400, "Business name is required", "BUSINESS_NAME_REQUIRED");
    }

    const email = body.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError(409, "Email already registered", "EMAIL_EXISTS");

    const tempPassword = body.password ?? `Kp${nanoid(10)}!`;
    const passwordHash = await hashSecret(tempPassword);
    const user = await prisma.user.create({
      data: {
        email,
        phone: body.phone?.trim() || null,
        passwordHash,
        firstName: body.firstName.trim(),
        middleName: body.middleName?.trim(),
        surname: body.surname.trim(),
        accountType: body.accountType,
        businessName: body.businessName?.trim() || null,
        businessRcNumber: body.businessRcNumber?.trim() || null,
        onboardedByAdminId: req.adminId,
        kycTier: body.kycTier ?? "TIER_0",
        referralCode: makeReferralCode(body.firstName),
        consents: {
          create: [
            { docKey: "terms", version: "1.0" },
            { docKey: "privacy", version: "1.0" },
          ],
        },
        notificationPrefs: { create: {} },
      },
    });
    await ensureUserWallet(user.id);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "user.admin_onboard",
      entityType: "User",
      entityId: user.id,
      after: { accountType: body.accountType, email },
    });
    await sendWelcomeEmail({
      to: email,
      firstName: user.firstName,
      tempPassword,
      accountType: body.accountType,
    }).catch((err) => console.warn("[welcome-email]", err));
  await createUserNotification({
    userId: user.id,
    title: "Welcome to Kipit",
    body: "Your Kipit account was created. Sign in and complete your profile when ready.",
    href: "/invest",
    pushKind: "general",
    skipPush: true,
  }).catch(() => undefined);

    res.status(201).json({
      data: {
        id: user.id,
        email: user.email,
        name: `${user.firstName} ${user.surname}`,
        accountType: user.accountType,
        tempPassword,
      },
    });
  }),
);

adminRouter.get(
  "/funnel/dropoffs",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await listSignupDropoffs(150);
    res.json({ data: rows });
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
    const profile = await prisma.kycProfile.findUnique({ where: { userId } });
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
        accountType: user.accountType,
        businessName: user.businessName,
        businessRcNumber: user.businessRcNumber,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        occupation: user.occupation,
        employmentStatus: user.employmentStatus,
        sourceOfFunds: user.sourceOfFunds,
        addressStreet: user.addressStreet,
        addressCity: user.addressCity,
        addressState: user.addressState,
        addressLga: user.addressLga,
        kycTier: user.kycTier,
        frozen: user.frozen,
        frozenReason: user.frozenReason,
        createdAt: user.createdAt,
        lastActiveAt,
        lastActive: fmtRelative(lastActiveAt),
        balances,
        kyc,
        // Docs for admin viewing (not a blocking review status once NIN auto-approves Tier 2)
        kycDocuments: {
          selfieUrl: profile?.selfieUrl ?? null,
          addressDocUrl: profile?.addressDocUrl ?? null,
          addressStreet: user.addressStreet,
          addressCity: user.addressCity,
          addressState: user.addressState,
          addressLga: user.addressLga,
          /** Full IDs for admin console only (customer getKycStatus stays masked). */
          bvn: profile?.bvn ?? null,
          nin: profile?.nin ?? null,
          ninName: profile?.ninName ?? null,
          bvnName: profile?.bvnName ?? null,
          bvnProviderStatus: profile?.bvnProviderStatus ?? null,
          ninProviderStatus: profile?.ninProviderStatus ?? null,
          occupation: user.occupation,
          employmentStatus: user.employmentStatus,
          sourceOfFunds: user.sourceOfFunds,
        },
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
      select: { id: true, type: true },
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ data: [] });
      return;
    }
    const lines = await prisma.journalLine.findMany({
      where: { accountId: { in: accountIds } },
      include: {
        entry: true,
        account: { select: { type: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    // One row per journal; prefer wallet/call lines so maturity shows the customer credit.
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
      .filter((line) => {
        const kind = String(line.entry.kind || "").toUpperCase();
        const desc = String(line.entry.description || "");
        // Placement-only / legacy maturity-interest legs — payout row already has full amount.
        if (kind === "INTEREST" && /maturity\s*interest/i.test(desc)) return false;
        if (line.account.type === "USER_PLACEMENT" && kind.includes("MATURITY")) return false;
        return true;
      })
      .slice(0, 100)
      .map((line) => {
        const kind = String(line.entry.kind || "").toUpperCase();
        let description = line.entry.description;
        if (kind.includes("MATURITY")) {
          const name = String(line.entry.description || "")
            .replace(/^(Early\s+)?Maturity(\s+payout)?\s*[:·-]\s*/i, "")
            .replace(/\(full profit\)\s*/i, "")
            .trim();
          description = name ? `Maturity payout · ${name}` : "Maturity payout";
        }
        return {
          id: line.entry.id,
          reference: line.entry.reference,
          kind: line.entry.kind,
          amount: koboToNaira(line.amountKobo < 0n ? -line.amountKobo : line.amountKobo),
          direction: line.amountKobo < 0n ? "debit" : "credit",
          createdAt: line.entry.createdAt,
          description,
        };
      });
    res.json({ data: rows });
  }),
);

/** Global placements register (ADM — operations). */
adminRouter.get(
  "/placements",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        userId: z.string().optional(),
        q: z.string().optional(),
        kind: z.enum(["FIXED", "EXPLORE"]).optional(),
        planType: z.enum(["LOCK", "FLEX"]).optional(),
        interestPayout: z.enum(["AT_MATURITY", "UPFRONT"]).optional(),
        amountMin: z.coerce.number().optional(),
        amountMax: z.coerce.number().optional(),
        placedFrom: z.string().optional(),
        placedTo: z.string().optional(),
        maturityFrom: z.string().optional(),
        maturityTo: z.string().optional(),
        status: z.enum(["active", "matured", "broken", "break pending"]).optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(200).default(100),
      })
      .parse(req.query);

    const where: Prisma.PlacementWhereInput = {};
    if (q.userId) where.userId = q.userId;
    if (q.kind) where.kind = q.kind;
    if (q.planType) where.planType = q.planType;
    if (q.interestPayout) where.interestPayout = q.interestPayout;
    if (q.amountMin != null || q.amountMax != null) {
      where.principalKobo = {};
      if (q.amountMin != null) where.principalKobo.gte = nairaToKobo(q.amountMin);
      if (q.amountMax != null) where.principalKobo.lte = nairaToKobo(q.amountMax);
    }
    if (q.placedFrom || q.placedTo) {
      where.startDate = {};
      if (q.placedFrom) where.startDate.gte = new Date(q.placedFrom);
      if (q.placedTo) {
        const end = new Date(q.placedTo);
        end.setUTCHours(23, 59, 59, 999);
        where.startDate.lte = end;
      }
    }
    if (q.maturityFrom || q.maturityTo) {
      where.maturityDate = {};
      if (q.maturityFrom) where.maturityDate.gte = new Date(q.maturityFrom);
      if (q.maturityTo) {
        const end = new Date(q.maturityTo);
        end.setUTCHours(23, 59, 59, 999);
        where.maturityDate.lte = end;
      }
    }
    if (q.q?.trim()) {
      const term = q.q.trim();
      where.user = {
        OR: [
          { email: { contains: term, mode: "insensitive" } },
          { firstName: { contains: term, mode: "insensitive" } },
          { surname: { contains: term, mode: "insensitive" } },
          { phone: { contains: term.replace(/\D/g, "") } },
        ],
      };
    }

    let rows = await prisma.placement.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, surname: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    if (q.status) {
      rows = rows.filter((p) => placementDisplayStatus(p) === q.status);
    }

    const total = rows.length;
    const start = (q.page - 1) * q.pageSize;
    const pageRows = rows.slice(start, start + q.pageSize);

    res.json({
      data: pageRows.map((p) =>
        serializeAdminPlacement(p, {
          id: p.userId,
          name: `${p.user.firstName} ${p.user.surname}`.trim(),
          email: p.user.email,
        }),
      ),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      },
    });
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
      data: rows.map((p) => {
        const detail = serializeAdminPlacement(p);
        const interest = placementInterestKobo(p);
        return {
          ...detail,
          expectedPayout: koboToNaira(p.principalKobo + interest),
          expectedInterest: detail.expectedNet ?? koboToNaira(interest),
        };
      }),
    });
  }),
);

/** Admin early-mature: full tenor interest, settle now (shorter hold). */
adminRouter.post(
  "/users/:userId/placements/:placementId/mature",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    if (req.adminRole === "READ_ONLY") {
      throw new AppError(403, "Insufficient permissions", "FORBIDDEN");
    }
    const userId = String(req.params.userId);
    const placementId = String(req.params.placementId);
    const placement = await prisma.placement.findFirst({
      where: { id: placementId, userId },
    });
    if (!placement) throw new AppError(404, "Placement not found", "NOT_FOUND");

    const { maturePlacement } = await import("../services/mature-placement.js");
    const result = await maturePlacement({ placementId, early: true });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "placement.admin_early_mature",
      entityType: "Placement",
      entityId: placementId,
      after: {
        principal: result.principal,
        interest: result.interest,
        payout: result.payout,
        daysHeld: result.daysHeld,
        tenorDays: result.tenorDays,
      },
    });

    res.json({ data: result });
  }),
);

adminRouter.post(
  "/users/:userId/placements",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const body = z
      .object({
        kind: z.enum(["FIXED", "CALL", "EXPLORE"]).default("FIXED"),
        amount: z.number().positive(),
        tenorDays: z.number().int().positive().optional(),
        planType: z.enum(["LOCK", "FLEX"]).optional(),
        interestPayout: z.enum(["AT_MATURITY", "UPFRONT"]).optional(),
        name: z.string().min(1).default("Admin placement"),
        productId: z.string().optional(),
        maturityInstruction: z.enum(["WALLET", "ROLLOVER", "PAYOUT"]).default("WALLET"),
        debitWallet: z.boolean().default(true),
        /** Super-admin overrides */
        startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
        maturityDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
        ratePct: z.number().nonnegative().optional(),
        expectedInterest: z.number().nonnegative().optional(),
        expectedPayout: z.number().positive().optional(),
        accrued: z.number().nonnegative().optional(),
        status: z.enum(["ACTIVE", "MATURED", "CLOSED"]).optional(),
      })
      .parse(req.body);

    const hasOverrides =
      body.startDate != null ||
      body.maturityDate != null ||
      body.ratePct != null ||
      body.expectedInterest != null ||
      body.expectedPayout != null ||
      body.accrued != null ||
      body.status != null;
    if (hasOverrides) assertSuperAdmin(req);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    if (user.frozen) throw new AppError(403, "User is frozen", "USER_FROZEN");

    const amountKobo = nairaToKobo(body.amount);
    await ensureUserWallet(userId);

    if (body.kind === "CALL") {
      const { moveWalletToCall } = await import("../services/money.js");
      const { interestValueDate } = await import("../services/system-settings.js");
      const value = await interestValueDate();
      await moveWalletToCall(userId, amountKobo, `admin-call-${nanoid(10)}`);
      await writeAudit({
        actorAdminId: req.adminId,
        action: "placement.admin_call_deposit",
        entityType: "User",
        entityId: userId,
        after: { amount: body.amount },
      });
      await notifyCustomer({
        userId,
        title: "Added to Call Account",
        body: `₦${body.amount.toLocaleString()} moved from your wallet into Call Account.${
          value.sameDay
            ? " Interest starts today."
            : ` Interest starts ${value.valueDate} (after ${value.cutoff} Lagos value cut-off).`
        }`,
        href: "/call-account",
        emailKind: "investment",
        amountNaira: body.amount,
        emailDetail: value.sameDay
          ? "Call Account top-up — interest starts today"
          : `Call Account top-up — interest starts ${value.valueDate}`,
      }).catch(() => undefined);
      const call = await ensureUserCall(userId);
      res.status(201).json({
        data: { kind: "CALL", balance: koboToNaira(call.balanceKobo) },
      });
      return;
    }

    const planType = body.planType ?? "LOCK";
    const interestPayout =
      planType === "FLEX" ? "AT_MATURITY" : (body.interestPayout ?? "AT_MATURITY");

    let rateBps = 0;
    let tenorDays = body.tenorDays ?? 90;
    let productId: string | null = body.productId ?? null;
    let name = body.name;

    if (body.kind === "EXPLORE") {
      if (!body.productId) throw new AppError(400, "productId required", "PRODUCT_REQUIRED");
      const product = await prisma.product.findUnique({ where: { id: body.productId } });
      if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
      if (product.availability !== "OPEN") {
        throw new AppError(400, "Product is not open for new placements", "PRODUCT_UNAVAILABLE");
      }
      if (amountKobo < product.minimumKobo) {
        throw new AppError(400, "Below product minimum", "BELOW_MINIMUM");
      }
      rateBps = product.rateBps;
      tenorDays = product.tenorDays;
      productId = product.id;
      name = product.name;
    } else {
      if (body.amount < PLAN_MIN_NAIRA) {
        throw new AppError(
          400,
          `Minimum fixed placement is ₦${PLAN_MIN_NAIRA.toLocaleString("en-NG")}`,
          "BELOW_MINIMUM",
        );
      }
      if (body.ratePct == null && body.expectedInterest == null && body.expectedPayout == null) {
        const resolved = await resolvePlanRate({
          planType,
          tenorDays,
          interestPayout,
        });
        rateBps = resolved.rateBps;
      }
      const genericName =
        name === "Admin placement" || name === "Fixed plan" || name.toLowerCase() === "my plan";
      if (genericName) {
        name = displayPlanName(planType, tenorDays);
      }
    }

    let startDate: Date;
    if (body.startDate) {
      startDate = new Date(body.startDate);
    } else if (body.kind === "FIXED") {
      const { interestValueDate, lagosDayStartUtc } = await import("../services/system-settings.js");
      const value = await interestValueDate();
      startDate = lagosDayStartUtc(value.valueDate);
    } else {
      startDate = new Date();
    }
    let maturityDate: Date;
    if (body.maturityDate) {
      maturityDate = new Date(body.maturityDate);
      if (body.tenorDays == null) {
        tenorDays = daysBetween(startDate, maturityDate);
      }
    } else {
      maturityDate = new Date(startDate);
      if (body.kind === "FIXED") {
        maturityDate.setUTCDate(maturityDate.getUTCDate() + tenorDays);
      } else {
        maturityDate.setDate(maturityDate.getDate() + tenorDays);
      }
    }

    if (body.ratePct != null) {
      rateBps = Math.round(body.ratePct * 10000);
    } else if (body.expectedPayout != null) {
      const interestKobo = nairaToKobo(body.expectedPayout) - amountKobo;
      rateBps = rateBpsFromInterest(amountKobo, tenorDays, interestKobo < 0n ? 0n : interestKobo);
    } else if (body.expectedInterest != null) {
      rateBps = rateBpsFromInterest(amountKobo, tenorDays, nairaToKobo(body.expectedInterest));
    }

    const placementTag = `placement_${nanoid(10)}`;
    const placementAccount = await prisma.ledgerAccount.create({
      data: {
        userId,
        type: "USER_PLACEMENT",
        tag: placementTag,
        currency: "NGN",
        balanceKobo: 0n,
      },
    });

    if (body.debitWallet) {
      await debitWallet({
        userId,
        amountKobo,
        kind: "PLACEMENT",
        idempotencyKey: `admin-place-${nanoid(12)}`,
        description: `Admin placement: ${name}`,
        creditAccountId: placementAccount.id,
      });
    } else {
      const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
      await creditWalletFrom({
        userId,
        amountKobo,
        kind: "ADJUSTMENT",
        idempotencyKey: `admin-seed-${nanoid(12)}`,
        description: `Admin seed before placement: ${name}`,
        debitAccountId: suspense.id,
      });
      await debitWallet({
        userId,
        amountKobo,
        kind: "PLACEMENT",
        idempotencyKey: `admin-place-${nanoid(12)}`,
        description: `Admin placement: ${name}`,
        creditAccountId: placementAccount.id,
      });
    }

    let interestOverrideKobo: bigint | null = null;
    if (body.expectedPayout != null) {
      const interestKobo = nairaToKobo(body.expectedPayout) - amountKobo;
      interestOverrideKobo = interestKobo < 0n ? 0n : interestKobo;
    } else if (body.expectedInterest != null) {
      interestOverrideKobo = nairaToKobo(body.expectedInterest);
    }
    const expectedInterest =
      interestOverrideKobo != null
        ? interestOverrideKobo
        : interestForPeriod(amountKobo, rateBps, tenorDays);
    const accruedKobo = body.accrued != null ? nairaToKobo(body.accrued) : 0n;

    const placement = await prisma.placement.create({
      data: {
        userId,
        kind: body.kind === "EXPLORE" ? "EXPLORE" : "FIXED",
        productId,
        name,
        principalKobo: amountKobo,
        rateBps,
        tenorDays,
        startDate,
        maturityDate,
        maturityInstruction: body.maturityInstruction,
        ledgerAccountId: placementAccount.id,
        accruedKobo,
        interestOverrideKobo,
        // C9 — persist Lock/Flex so placements list, dashboard and Flex break rules work.
        ...(body.kind !== "EXPLORE" ? { planType, interestPayout } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "placement.admin_create",
      entityType: "Placement",
      entityId: placement.id,
      after: {
        amount: body.amount,
        kind: placement.kind,
        planType: placement.planType,
        interestPayout: placement.interestPayout,
        startDate: startDate.toISOString(),
        maturityDate: maturityDate.toISOString(),
        rateBps,
        interestOverrideKobo: interestOverrideKobo != null ? koboToNaira(interestOverrideKobo) : null,
        overrides: hasOverrides,
      },
    });
    await notifyCustomer({
      userId,
      title: "Investment confirmed",
      body: `₦${body.amount.toLocaleString()} invested in ${name} by Kipit operations.`,
      href: "/portfolio",
      emailKind: "investment",
      amountNaira: body.amount,
      emailDetail: `${name} · ${tenorDays} days`,
    }).catch(() => undefined);

    res.status(201).json({
      data: {
        id: placement.id,
        name: placement.name,
        kind: placement.kind,
        planType: placement.planType,
        interestPayout: placement.interestPayout,
        amount: body.amount,
        ratePct: rateBps / 10000,
        tenorDays,
        startDate: startDate.toISOString().slice(0, 10),
        maturityDate: maturityDate.toISOString().slice(0, 10),
        expectedInterest: koboToNaira(expectedInterest),
        expectedPayout: koboToNaira(amountKobo + expectedInterest),
      },
    });
  }),
);

/** Super-admin: edit any field on an existing placement. */
adminRouter.patch(
  "/users/:userId/placements/:placementId",
  requireAdmin,
  requireRoles("SUPER"),
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const placementId = String(req.params.placementId);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        principal: z.number().positive().optional(),
        ratePct: z.number().nonnegative().optional(),
        tenorDays: z.number().int().positive().optional(),
        startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
        maturityDate: z
          .string()
          .datetime({ offset: true })
          .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
          .nullable()
          .optional(),
        expectedInterest: z.number().nonnegative().optional(),
        expectedPayout: z.number().positive().optional(),
        accrued: z.number().nonnegative().optional(),
        status: z.enum(["ACTIVE", "MATURED", "CLOSED"]).optional(),
        maturityInstruction: z.enum(["WALLET", "ROLLOVER", "PAYOUT"]).optional(),
        kind: z.enum(["FIXED", "CALL", "EXPLORE"]).optional(),
      })
      .parse(req.body);

    const placement = await prisma.placement.findFirst({
      where: { id: placementId, userId },
    });
    if (!placement) throw new AppError(404, "Placement not found", "NOT_FOUND");

    const before = {
      name: placement.name,
      principal: koboToNaira(placement.principalKobo),
      ratePct: placement.rateBps / 10000,
      tenorDays: placement.tenorDays,
      startDate: placement.startDate,
      maturityDate: placement.maturityDate,
      status: placement.status,
      accrued: koboToNaira(placement.accruedKobo),
      maturityInstruction: placement.maturityInstruction,
      kind: placement.kind,
    };

    let principalKobo = placement.principalKobo;
    if (body.principal != null) principalKobo = nairaToKobo(body.principal);

    let startDate = placement.startDate;
    if (body.startDate) startDate = new Date(body.startDate);

    let maturityDate = placement.maturityDate;
    if (body.maturityDate === null) maturityDate = null;
    else if (body.maturityDate) maturityDate = new Date(body.maturityDate);

    let tenorDays = body.tenorDays ?? placement.tenorDays ?? 0;
    if (body.tenorDays == null && body.startDate && maturityDate) {
      tenorDays = daysBetween(startDate, maturityDate);
    } else if (body.maturityDate && body.tenorDays == null && maturityDate) {
      tenorDays = daysBetween(startDate, maturityDate);
    } else if (body.startDate && body.maturityDate == null && body.tenorDays == null && maturityDate) {
      tenorDays = daysBetween(startDate, maturityDate);
    } else if (body.tenorDays != null && body.maturityDate == null) {
      maturityDate = new Date(startDate);
      maturityDate.setDate(maturityDate.getDate() + tenorDays);
    }

    let rateBps = placement.rateBps;
    /** Exact interest from SUPER payout/interest fields — survives rate↔interest integer rounding. */
    let interestOverrideKobo: bigint | null | undefined = undefined;
    if (body.expectedPayout != null) {
      const interestKobo = nairaToKobo(body.expectedPayout) - principalKobo;
      interestOverrideKobo = interestKobo < 0n ? 0n : interestKobo;
      rateBps = rateBpsFromInterest(principalKobo, tenorDays || 1, interestOverrideKobo);
    } else if (body.expectedInterest != null) {
      interestOverrideKobo = nairaToKobo(body.expectedInterest);
      rateBps = rateBpsFromInterest(principalKobo, tenorDays || 1, interestOverrideKobo);
    } else if (body.ratePct != null) {
      rateBps = Math.round(body.ratePct * 10000);
      // Explicit rate edit: clear override so formula drives expected again.
      interestOverrideKobo = null;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.placement.update({
        where: { id: placementId },
        data: {
          ...(body.name != null ? { name: body.name } : {}),
          ...(body.kind != null && body.kind !== "CALL" ? { kind: body.kind } : {}),
          principalKobo,
          rateBps,
          tenorDays: tenorDays || null,
          startDate,
          maturityDate,
          ...(body.status != null ? { status: body.status } : {}),
          ...(body.maturityInstruction != null
            ? { maturityInstruction: body.maturityInstruction }
            : {}),
          ...(body.accrued != null ? { accruedKobo: nairaToKobo(body.accrued) } : {}),
          ...(interestOverrideKobo !== undefined
            ? { interestOverrideKobo }
            : {}),
        },
      });

      if (body.principal != null && placement.ledgerAccountId) {
        await tx.ledgerAccount.update({
          where: { id: placement.ledgerAccountId },
          data: { balanceKobo: principalKobo },
        });
      }

      return row;
    });

    const interest = placementInterestKobo(updated);

    await writeAudit({
      actorAdminId: req.adminId,
      action: "placement.admin_update",
      entityType: "Placement",
      entityId: placementId,
      before,
      after: {
        name: updated.name,
        principal: koboToNaira(updated.principalKobo),
        ratePct: updated.rateBps / 10000,
        tenorDays: updated.tenorDays,
        startDate: updated.startDate,
        maturityDate: updated.maturityDate,
        status: updated.status,
        accrued: koboToNaira(updated.accruedKobo),
        interestOverride:
          updated.interestOverrideKobo != null
            ? koboToNaira(updated.interestOverrideKobo)
            : null,
        maturityInstruction: updated.maturityInstruction,
        kind: updated.kind,
      },
    });

    res.json({
      data: {
        id: updated.id,
        name: updated.name,
        kind: updated.kind,
        status: updated.status,
        principal: koboToNaira(updated.principalKobo),
        ratePct: updated.rateBps / 10000,
        tenorDays: updated.tenorDays,
        expectedInterest: koboToNaira(interest),
        expectedPayout: koboToNaira(updated.principalKobo + interest),
        accrued: koboToNaira(updated.accruedKobo),
        interestOverride: updated.interestOverrideKobo != null,
        maturityInstruction: updated.maturityInstruction,
        startDate: updated.startDate,
        maturityDate: updated.maturityDate,
        createdAt: updated.createdAt,
      },
    });
  }),
);

adminRouter.get(
  "/users/:userId/sessions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.session.findMany({
      where: { userId: String(req.params.userId) },
      orderBy: { lastActiveAt: "desc" },
      take: 50,
    });
    const now = Date.now();
    const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
    let markedCurrent = false;
    res.json({
      data: rows.map((s) => {
        const revoked = Boolean(s.revokedAt);
        const fresh = now - s.lastActiveAt.getTime() < ACTIVE_MS;
        const current = !revoked && !markedCurrent;
        if (current) markedCurrent = true;
        return {
          id: s.id,
          deviceName: s.deviceName,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          lastActiveAt: s.lastActiveAt,
          revokedAt: s.revokedAt,
          createdAt: s.createdAt,
          current,
          active: !revoked && fresh,
        };
      }),
    });
  }),
);

adminRouter.post(
  "/users/:userId/sessions/:sessionId/revoke",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const sessionId = String(req.params.sessionId);
    const result = await prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new AppError(404, "Session not found", "NOT_FOUND");
    await writeAudit({
      actorAdminId: req.adminId,
      action: "user.session.revoked",
      entityType: "Session",
      entityId: sessionId,
      after: { userId },
    });
    res.json({ data: { id: sessionId, revoked: true } });
  }),
);

adminRouter.patch(
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
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });
    await notifyAccountAccessChange({
      userId: user.id,
      frozen: body.frozen,
      reason: reason ?? undefined,
    }).catch((err) => console.warn("[admin] freeze notify failed", err));
    res.json({ data: { id: user.id, frozen: user.frozen, frozenReason: user.frozenReason } });
  }),
);

/** Reset customer login password and email a temporary password. */
adminRouter.post(
  "/users/:userId/reset-password",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    if (!user.email?.trim()) {
      throw new AppError(400, "This customer has no email on file to receive a password.", "EMAIL_REQUIRED");
    }

    const tempPassword = `Kp${nanoid(10)}!`;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashSecret(tempPassword),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    let emailed = true;
    try {
      await sendCustomerPasswordResetEmail({
        to: user.email,
        firstName: user.firstName,
        tempPassword,
      });
    } catch (err) {
      emailed = false;
      console.warn("[customer-password-reset-email]", err);
    }

    await writeAudit({
      actorAdminId: req.adminId,
      action: "user.password_reset",
      entityType: "User",
      entityId: user.id,
      after: { emailed },
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });

    await notifyCustomer({
      userId: user.id,
      title: "Password reset",
      body: "An administrator reset your login password. Check your email for a temporary password.",
      href: "/settings/security",
      pushKind: "security",
    }).catch(() => undefined);

    res.json({
      data: {
        id: user.id,
        email: user.email,
        emailed,
        /** Returned so ops can share if email delivery fails. */
        tempPassword,
      },
    });
  }),
);

/** SUPER: credit or debit wallet / call balance. */
adminRouter.post(
  "/users/:userId/wallet/adjust",
  requireAdmin,
  requireRoles("SUPER"),
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const body = z
      .object({
        pool: z.enum(["WALLET", "CALL"]).default("WALLET"),
        direction: z.enum(["credit", "debit"]),
        amount: z.number().positive(),
        reason: z.string().min(3).max(500),
      })
      .parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");

    const amountKobo = nairaToKobo(body.amount);
    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    const idempotencyKey = `admin-bal-${body.direction}-${body.pool}-${nanoid(12)}`;
    const description = `Admin ${body.direction} (${body.pool}): ${body.reason}`;

    if (body.pool === "WALLET") {
      if (body.direction === "credit") {
        await creditWalletFrom({
          userId,
          amountKobo,
          kind: "ADJUSTMENT",
          idempotencyKey,
          description,
          debitAccountId: suspense.id,
          metadata: { reason: body.reason, actorAdminId: req.adminId },
        });
      } else {
        await debitWallet({
          userId,
          amountKobo,
          kind: "ADJUSTMENT",
          idempotencyKey,
          description,
          creditAccountId: suspense.id,
          metadata: { reason: body.reason, actorAdminId: req.adminId },
        });
      }
    } else {
      const { creditCallFrom, postJournal } = await import("../services/money.js");
      const call = await ensureUserCall(userId);
      if (body.direction === "credit") {
        await creditCallFrom({
          userId,
          amountKobo,
          kind: "ADJUSTMENT",
          idempotencyKey,
          description,
          debitAccountId: suspense.id,
          metadata: { reason: body.reason, actorAdminId: req.adminId },
        });
      } else {
        if (call.balanceKobo < amountKobo) {
          throw new AppError(400, "Insufficient Call Account balance", "INSUFFICIENT_FUNDS");
        }
        await postJournal({
          kind: "ADJUSTMENT",
          idempotencyKey,
          description,
          metadata: { reason: body.reason, actorAdminId: req.adminId },
          lines: [
            { accountId: call.id, amountKobo: -amountKobo },
            { accountId: suspense.id, amountKobo },
          ],
        });
      }
    }

    const balances = await userBalances(userId);
    await writeAudit({
      actorAdminId: req.adminId,
      action: `balance.admin_${body.direction}`,
      entityType: "User",
      entityId: userId,
      after: {
        pool: body.pool,
        direction: body.direction,
        amount: body.amount,
        reason: body.reason,
        balances,
      },
    });

    res.json({ data: { balances, pool: body.pool, direction: body.direction, amount: body.amount } });
  }),
);

/** SUPER: edit customer profile fields. */
adminRouter.patch(
  "/users/:userId",
  requireAdmin,
  requireRoles("SUPER"),
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const body = z
      .object({
        email: z.string().email().optional(),
        phone: z.string().nullable().optional(),
        firstName: z.string().min(1).optional(),
        middleName: z.string().nullable().optional(),
        surname: z.string().min(1).optional(),
        accountType: z.enum(["PERSONAL", "BUSINESS"]).optional(),
        businessName: z.string().nullable().optional(),
        businessRcNumber: z.string().nullable().optional(),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(),
        gender: z.string().nullable().optional(),
        occupation: z.string().nullable().optional(),
        employmentStatus: z.string().nullable().optional(),
        sourceOfFunds: z.string().nullable().optional(),
        addressStreet: z.string().nullable().optional(),
        addressCity: z.string().nullable().optional(),
        addressState: z.string().nullable().optional(),
        addressLga: z.string().nullable().optional(),
        kycTier: z.enum(["TIER_0", "TIER_1", "TIER_2"]).optional(),
        frozen: z.boolean().optional(),
        frozenReason: z.string().nullable().optional(),
      })
      .parse(req.body);

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new AppError(404, "User not found", "NOT_FOUND");

    if (body.email && body.email.toLowerCase() !== (existing.email ?? "").toLowerCase()) {
      const clash = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (clash && clash.id !== userId) {
        throw new AppError(409, "Email already registered", "EMAIL_EXISTS");
      }
    }
    if (body.phone !== undefined && body.phone) {
      const phone = body.phone.replace(/\D/g, "");
      const clash = await prisma.user.findFirst({
        where: { phone, NOT: { id: userId } },
      });
      if (clash) throw new AppError(409, "Phone already registered", "PHONE_EXISTS");
    }

    const before = {
      email: existing.email,
      phone: existing.phone,
      firstName: existing.firstName,
      surname: existing.surname,
      kycTier: existing.kycTier,
      frozen: existing.frozen,
    };

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.email != null ? { email: body.email.toLowerCase().trim() } : {}),
        ...(body.phone !== undefined
          ? { phone: body.phone ? body.phone.replace(/\D/g, "") : null }
          : {}),
        ...(body.firstName != null ? { firstName: body.firstName.trim() } : {}),
        ...(body.middleName !== undefined
          ? { middleName: body.middleName?.trim() || null }
          : {}),
        ...(body.surname != null ? { surname: body.surname.trim() } : {}),
        ...(body.accountType != null ? { accountType: body.accountType } : {}),
        ...(body.businessName !== undefined
          ? { businessName: body.businessName?.trim() || null }
          : {}),
        ...(body.businessRcNumber !== undefined
          ? { businessRcNumber: body.businessRcNumber?.trim() || null }
          : {}),
        ...(body.dateOfBirth !== undefined
          ? { dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null }
          : {}),
        ...(body.gender !== undefined ? { gender: body.gender?.trim() || null } : {}),
        ...(body.occupation !== undefined
          ? { occupation: body.occupation?.trim() || null }
          : {}),
        ...(body.employmentStatus !== undefined
          ? { employmentStatus: body.employmentStatus?.trim() || null }
          : {}),
        ...(body.sourceOfFunds !== undefined
          ? { sourceOfFunds: body.sourceOfFunds?.trim() || null }
          : {}),
        ...(body.addressStreet !== undefined
          ? { addressStreet: body.addressStreet?.trim() || null }
          : {}),
        ...(body.addressCity !== undefined
          ? { addressCity: body.addressCity?.trim() || null }
          : {}),
        ...(body.addressState !== undefined
          ? { addressState: body.addressState?.trim() || null }
          : {}),
        ...(body.addressLga !== undefined
          ? { addressLga: body.addressLga?.trim() || null }
          : {}),
        ...(body.kycTier != null ? { kycTier: body.kycTier } : {}),
        ...(body.frozen != null ? { frozen: body.frozen } : {}),
        ...(body.frozenReason !== undefined ? { frozenReason: body.frozenReason } : {}),
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "user.admin_profile_update",
      entityType: "User",
      entityId: userId,
      before,
      after: body,
    });

    res.json({
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        middleName: user.middleName,
        surname: user.surname,
        name: `${user.firstName} ${user.surname}`,
        accountType: user.accountType,
        businessName: user.businessName,
        businessRcNumber: user.businessRcNumber,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        occupation: user.occupation,
        employmentStatus: user.employmentStatus,
        sourceOfFunds: user.sourceOfFunds,
        addressStreet: user.addressStreet,
        addressCity: user.addressCity,
        addressState: user.addressState,
        addressLga: user.addressLga,
        kycTier: user.kycTier,
        frozen: user.frozen,
      },
    });
  }),
);

/** SUPER: upload KYC selfie / address proof for a customer. */
adminRouter.post(
  "/users/:userId/kyc/documents",
  requireAdmin,
  requireRoles("SUPER"),
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const body = z
      .object({
        kind: z.enum(["selfie", "address"]),
        contentType: z.string().min(3),
        dataBase64: z.string().min(20),
      })
      .parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");

    const { saveKycDocument } = await import("../services/uploads.js");
    const saved = await saveKycDocument({
      userId,
      kind: body.kind,
      contentType: body.contentType,
      dataBase64: body.dataBase64,
    });

    const profile = await prisma.kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        status: "PENDING_REVIEW",
        ...(body.kind === "selfie"
          ? { selfieUrl: saved.url, livenessPassed: true }
          : { addressDocUrl: saved.url }),
      },
      update: {
        ...(body.kind === "selfie"
          ? { selfieUrl: saved.url, livenessPassed: true }
          : { addressDocUrl: saved.url }),
        status: "PENDING_REVIEW",
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "kyc.admin_document_upload",
      entityType: "User",
      entityId: userId,
      after: { kind: body.kind, url: saved.url },
    });

    res.json({
      data: {
        kind: body.kind,
        url: saved.url,
        status: profile.status,
        selfieUrl: profile.selfieUrl,
        addressDocUrl: profile.addressDocUrl,
      },
    });
  }),
);

/** SUPER: complete / activate KYC for an admin-registered customer. */
adminRouter.post(
  "/users/:userId/kyc/activate",
  requireAdmin,
  requireRoles("SUPER"),
  asyncHandler(async (req: AdminRequest, res) => {
    const userId = String(req.params.userId);
    const body = z
      .object({
        kycTier: z.enum(["TIER_1", "TIER_2"]),
        bvn: z.string().optional(),
        nin: z.string().optional(),
        bvnName: z.string().optional(),
        ninName: z.string().optional(),
        unfreeze: z.boolean().default(true),
      })
      .parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");

    const displayName = `${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`.trim();
    await prisma.kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        status: "APPROVED",
        bvn: body.bvn?.replace(/\D/g, "") || null,
        nin: body.nin?.replace(/\D/g, "") || null,
        bvnName: body.bvnName || (body.kycTier === "TIER_1" ? displayName : null),
        ninName: body.ninName || (body.kycTier === "TIER_2" ? displayName : null),
        bvnProviderStatus: body.kycTier === "TIER_1" ? "SUCCESS" : null,
        ninProviderStatus: body.kycTier === "TIER_2" ? "SUCCESS" : null,
        livenessPassed: true,
        reviewedByAdminId: req.adminId,
        reviewedAt: new Date(),
      },
      update: {
        status: "APPROVED",
        ...(body.bvn ? { bvn: body.bvn.replace(/\D/g, "") } : {}),
        ...(body.nin ? { nin: body.nin.replace(/\D/g, "") } : {}),
        ...(body.bvnName ? { bvnName: body.bvnName } : {}),
        ...(body.ninName ? { ninName: body.ninName } : {}),
        bvnProviderStatus: body.kycTier === "TIER_1" || body.kycTier === "TIER_2" ? "SUCCESS" : undefined,
        ninProviderStatus: body.kycTier === "TIER_2" ? "SUCCESS" : undefined,
        livenessPassed: true,
        rejectionReason: null,
        reviewedByAdminId: req.adminId,
        reviewedAt: new Date(),
      },
    });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        kycTier: body.kycTier,
        ...(body.unfreeze ? { frozen: false, frozenReason: null } : {}),
      },
    });

    await writeAudit({
      actorAdminId: req.adminId,
      action: "kyc.admin_activate",
      entityType: "User",
      entityId: userId,
      after: { kycTier: body.kycTier, unfreeze: body.unfreeze },
    });

    res.json({
      data: {
        id: updated.id,
        kycTier: updated.kycTier,
        frozen: updated.frozen,
      },
    });
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
        hasSelfie: Boolean(r.selfieUrl),
        hasAddressDoc: Boolean(r.addressDocUrl),
        selfieUrl: r.selfieUrl,
        addressDocUrl: r.addressDocUrl,
        ninProviderStatus: r.ninProviderStatus,
        bvnProviderStatus: r.bvnProviderStatus,
        tierTarget: r.nin ? 2 : 1,
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
    const { getOpsCutoffs, settleOnFromCutoff, lagosDateKey } = await import(
      "../services/system-settings.js"
    );
    const { payoutBatch } = await getOpsCutoffs();
    const today = lagosDateKey();
    res.json({
      data: rows.map((r) => {
        const settlement = settleOnFromCutoff(r.createdAt, payoutBatch);
        return {
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
          settleOn: settlement.settleOn,
          sameDaySettlement: settlement.sameDay,
          payoutCutoff: settlement.cutoff,
          batchReady: settlement.settleOn <= today,
        };
      }),
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

    const force = String(req.query.force ?? "") === "1" || String(req.query.force ?? "") === "true";
    const { settleOnFromCutoff, getOpsCutoffs, lagosDateKey } = await import(
      "../services/system-settings.js"
    );
    const { payoutBatch } = await getOpsCutoffs();
    const settlement = settleOnFromCutoff(row.createdAt, payoutBatch);
    const today = lagosDateKey();
    if (!force && settlement.settleOn > today) {
      throw new AppError(
        400,
        `This withdrawal is in the next-day batch (cut-off ${settlement.cutoff} Lagos). Settles on ${settlement.settleOn}. Pass ?force=1 to override.`,
        "BATCH_NOT_READY",
      );
    }

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
    await notifyCustomer({
      userId: row.userId,
      title: "Withdrawal successful",
      body: `Your withdrawal of ₦${koboToNaira(row.amountKobo).toLocaleString()} was paid out.`,
      href: "/withdraw/tracker",
      emailKind: "withdrawal_result",
      amountNaira: koboToNaira(row.amountKobo),
      emailDetail: "Paid to your bank account",
      pushKind: "withdrawal",
    }).catch(() => undefined);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "withdrawal.successful",
      entityType: "WithdrawalRequest",
      entityId: row.id,
      after: { transfer, settlement, forced: force },
    });
    res.json({ data: { id: row.id, status: "SUCCESSFUL", transfer, settleOn: settlement.settleOn } });
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

    await notifyCustomer({
      userId: row.userId,
      title: "Withdrawal declined",
      body: body.reason,
      href: "/withdraw/tracker",
      emailKind: "withdrawal_result",
      amountNaira: koboToNaira(row.amountKobo),
      emailDetail: body.reason,
      pushKind: "withdrawal",
    }).catch(() => undefined);

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
    const balances = await userBalances(r.userId);
    res.json({
      data: {
        id: r.id,
        reference: r.reference,
        status: r.status,
        amount: koboToNaira(r.amountKobo),
        declineReason: r.declineReason,
        // Flat fields — admin UI mapWithdrawalRow reads bank / accountName / accountNumber.
        bank: r.payoutBank.bankName,
        accountName: r.payoutBank.accountName,
        accountNumber: r.payoutBank.accountNumber,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
        user: {
          id: r.user.id,
          email: r.user.email,
          phone: r.user.phone,
          name: `${r.user.firstName} ${r.user.surname}`,
          kycTier: r.user.kycTier,
          createdAt: r.user.createdAt,
        },
        balances,
      },
    });
  }),
);

adminRouter.get(
  "/account-deletions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? "").toUpperCase();
    const where =
      status && ["SUBMITTED", "PROCESSING", "REJECTED", "DELETED"].includes(status)
        ? { status: status as "SUBMITTED" | "PROCESSING" | "REJECTED" | "DELETED" }
        : {};
    const rows = await prisma.accountDeletionRequest.findMany({
      where,
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const { serializeDeletionRequest } = await import("../services/account-deletion.js");
    const { ACCOUNT_DELETION_REASON_LABELS } = await import("../lib/account-deletion.js");
    res.json({
      data: rows.map((r) => ({
        ...serializeDeletionRequest(r),
        user: {
          id: r.user.id,
          name: `${r.user.firstName} ${r.user.surname}`,
          email: r.user.email,
          phone: r.user.phone,
          frozen: r.user.frozen,
          kycTier: r.user.kycTier,
        },
        reasonLabel:
          ACCOUNT_DELETION_REASON_LABELS[
            r.reasonCode as keyof typeof ACCOUNT_DELETION_REASON_LABELS
          ] ?? r.reasonCode,
      })),
    });
  }),
);

adminRouter.get(
  "/account-deletions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const r = await prisma.accountDeletionRequest.findUnique({
      where: { id: String(req.params.id) },
      include: { user: true },
    });
    if (!r) throw new AppError(404, "Deletion request not found", "NOT_FOUND");
    const balances = await userBalances(r.userId);
    const activePlacements = await prisma.placement.count({
      where: { userId: r.userId, status: "ACTIVE", kind: { in: ["FIXED", "EXPLORE"] } },
    });
    const pendingWithdrawals = await prisma.withdrawalRequest.count({
      where: { userId: r.userId, status: "PROCESSING" },
    });
    const { serializeDeletionRequest } = await import("../services/account-deletion.js");
    res.json({
      data: {
        ...serializeDeletionRequest(r),
        user: {
          id: r.user.id,
          name: `${r.user.firstName} ${r.user.surname}`,
          email: r.user.email,
          phone: r.user.phone,
          frozen: r.user.frozen,
          frozenReason: r.user.frozenReason,
          kycTier: r.user.kycTier,
          createdAt: r.user.createdAt,
        },
        balances,
        activePlacements,
        pendingWithdrawals,
        purgeEligible: Date.now() >= r.scheduledPurgeAt.getTime(),
      },
    });
  }),
);

adminRouter.patch(
  "/account-deletions/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        status: z.enum(["PROCESSING", "REJECTED", "DELETED"]),
        rejectionReason: z.string().trim().min(4).max(2000).optional(),
      })
      .parse(req.body);

    const row = await prisma.accountDeletionRequest.findUniqueOrThrow({
      where: { id: String(req.params.id) },
    });
    const {
      assertCanTransition,
      softAnonymizeUser,
      serializeDeletionRequest,
    } = await import("../services/account-deletion.js");

    assertCanTransition(row.status, body.status);

    if (body.status === "REJECTED") {
      if (!body.rejectionReason) {
        throw new AppError(400, "Rejection reason is required", "REASON_REQUIRED");
      }
      const updated = await prisma.accountDeletionRequest.update({
        where: { id: row.id },
        data: {
          status: "REJECTED",
          rejectionReason: body.rejectionReason,
          processedAt: new Date(),
          processedByAdminId: req.adminId,
        },
      });
      await notifyCustomer({
        userId: row.userId,
        title: "Deletion request declined",
        body: body.rejectionReason,
        href: "/settings/delete-account",
        pushKind: "security",
      }).catch(() => undefined);
      await writeAudit({
        actorAdminId: req.adminId,
        action: "account_deletion.rejected",
        entityType: "AccountDeletionRequest",
        entityId: row.id,
        after: { reason: body.rejectionReason },
      });
      res.json({ data: serializeDeletionRequest(updated) });
      return;
    }

    if (body.status === "PROCESSING") {
      const updated = await prisma.accountDeletionRequest.update({
        where: { id: row.id },
        data: {
          status: "PROCESSING",
          processedAt: new Date(),
          processedByAdminId: req.adminId,
        },
      });
      await notifyCustomer({
        userId: row.userId,
        title: "Deletion request in review",
        body: "Our team is reviewing your account deletion request and completing checks.",
        href: "/settings/delete-account",
        pushKind: "security",
      }).catch(() => undefined);
      await writeAudit({
        actorAdminId: req.adminId,
        action: "account_deletion.processing",
        entityType: "AccountDeletionRequest",
        entityId: row.id,
      });
      res.json({ data: serializeDeletionRequest(updated) });
      return;
    }

    // DELETED — soft anonymize after 30-day hold + balance checks
    if (Date.now() < row.scheduledPurgeAt.getTime()) {
      throw new AppError(
        400,
        `Mark deleted is only available on or after ${row.scheduledPurgeAt.toISOString().slice(0, 10)} (30-day hold).`,
        "PURGE_NOT_DUE",
      );
    }

    await softAnonymizeUser(row.userId, req.adminId);
    const updated = await prisma.accountDeletionRequest.update({
      where: { id: row.id },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
        processedAt: new Date(),
        processedByAdminId: req.adminId,
      },
    });
    // User identifiers cleared — in-app notify may no longer reach them; attempt anyway.
    await notifyCustomer({
      userId: row.userId,
      title: "Account deleted",
      body: "Your Kipit account has been deleted. You can register again with the same email or phone if you wish.",
      href: "/login",
      pushKind: "security",
    }).catch(() => undefined);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "account_deletion.deleted",
      entityType: "AccountDeletionRequest",
      entityId: row.id,
      after: { soft: true },
    });
    res.json({ data: serializeDeletionRequest(updated) });
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
    const { ensureRatesApplied, rateBandAdminExtras } = await import("../services/rates.js");
    await ensureRatesApplied();

    const { formatRatePair } = await import("../services/wht.js");
    const bands = await prisma.rateBand.findMany({
      orderBy: [{ family: "asc" }, { standardTenorDays: "asc" }, { payout: "asc" }, { minDays: "asc" }],
    });
    const placements = await prisma.placement.findMany({
      where: { status: "ACTIVE" },
      select: {
        kind: true,
        principalKobo: true,
        tenorDays: true,
        planType: true,
        interestPayout: true,
      },
    });
    const data = await Promise.all(
      bands.map(async (b) => {
        const isCallBand =
          b.family === "CALL" ||
          b.code.toUpperCase() === "CALL" ||
          (b.minDays === 0 && b.maxDays === 0);
        const matching = placements.filter((p) => {
          if (isCallBand) return p.kind === "CALL";
          if (p.kind === "CALL") return false;
          const days = p.tenorDays ?? 0;
          const planType = p.planType ?? "LOCK";
          if (b.family === "LOCK" || b.family === "FLEX") {
            if (planType !== b.family) return false;
            if (b.family === "LOCK") {
              const payout = p.interestPayout ?? "AT_MATURITY";
              if (b.payout && payout !== b.payout) return false;
            }
            if (b.standardTenorDays != null) return days === b.standardTenorDays;
          }
          if (b.maxDays == null) return days >= b.minDays;
          return days >= b.minDays && days <= b.maxDays;
        });
        const principalKobo = matching.reduce((s, p) => s + p.principalKobo, 0n);
        const extras = await rateBandAdminExtras(b.id, b.rateBps);
        const pair = formatRatePair(b.rateBps);
        return {
          ...b,
          ratePct: pair.netRatePct,
          grossRatePct: pair.grossRatePct,
          rateLabel: pair.label,
          previousBps: extras.previousBps,
          scheduledBps: extras.scheduledBps,
          scheduledFrom: extras.scheduledFrom,
          pendingBps: extras.pendingBps,
          pendingFrom: extras.pendingFrom,
          status: extras.status,
          placements: matching.length,
          principal: koboToNaira(principalKobo),
        };
      }),
    );
    res.json({ data });
  }),
);

adminRouter.post(
  "/rates/propose",
  requireAdmin,
  requirePermission("rate.propose"),
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        bandId: z.string(),
        // rateBps scale = percent × 10_000 (e.g. 22% → 220000). Cap ~40% net.
        proposedBps: z.number().int().positive().max(400_000),
        effectiveFrom: z.string(),
        reason: z.string().optional(),
      })
      .parse(req.body);
    const effective = new Date(body.effectiveFrom);
    if (Number.isNaN(effective.getTime())) {
      throw new AppError(400, "Effective date must be today or later", "INVALID_DATE");
    }
    // Compare calendar dates in UTC so timezone offsets don't reject "today".
    const effectiveDay = Date.UTC(
      effective.getUTCFullYear(),
      effective.getUTCMonth(),
      effective.getUTCDate(),
    );
    const now = new Date();
    const todayDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (effectiveDay < todayDay) {
      throw new AppError(400, "Effective date must be today or later", "INVALID_DATE");
    }
    const band = await prisma.rateBand.findUnique({ where: { id: body.bandId } });
    if (!band) throw new AppError(404, "Rate band not found", "BAND_NOT_FOUND");
    const row = await prisma.rateChangeRequest.create({
      data: {
        bandId: body.bandId,
        proposedBps: body.proposedBps,
        previousBps: band.rateBps,
        effectiveFrom: new Date(effectiveDay),
        reason: body.reason,
        makerAdminId: req.adminId!,
      },
    });
    const { formatRatePair } = await import("../services/wht.js");
    await writeAudit({
      actorAdminId: req.adminId,
      action: "rate.propose",
      entityType: "RateChangeRequest",
      entityId: row.id,
      after: {
        bandId: body.bandId,
        code: band.code,
        family: band.family,
        payout: band.payout,
        proposedBps: body.proposedBps,
        previousBps: band.rateBps,
        proposedRate: formatRatePair(body.proposedBps),
        previousRate: formatRatePair(band.rateBps),
        effectiveFrom: body.effectiveFrom,
      },
    });
    const { sendRateApprovalAlert } = await import("../services/admin-alerts.js");
    await sendRateApprovalAlert({
      requestId: row.id,
      bandName: band.label,
      proposedBps: body.proposedBps,
      previousBps: band.rateBps,
      effectiveFrom: body.effectiveFrom,
      makerAdminId: req.adminId!,
      makerName: req.adminName,
    }).catch((err) => console.warn("[rates] proposal alert email failed", err));
    res.status(201).json({ data: row });
  }),
);

adminRouter.post(
  "/rates/:requestId/decide",
  requireAdmin,
  requirePermission("rate.approve"),
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
      const { utcDayMs } = await import("../services/rates.js");
      const now = new Date();
      const dueNow = utcDayMs(row.effectiveFrom) <= utcDayMs(now);
      const band = await prisma.rateBand.findUniqueOrThrow({ where: { id: row.bandId } });
      const previousBps = row.previousBps ?? band.rateBps;

      if (dueNow) {
        await prisma.$transaction([
          prisma.rateBand.update({
            where: { id: row.bandId },
            data: { rateBps: row.proposedBps, effectiveFrom: row.effectiveFrom },
          }),
          prisma.rateChangeRequest.update({
            where: { id: row.id },
            data: {
              status: "APPROVED",
              previousBps,
              checkerAdminId: req.adminId,
              decidedAt: now,
              appliedAt: now,
            },
          }),
        ]);
      } else {
        // Approved but not yet live — RateBand stays on the current rate until effectiveFrom.
        await prisma.rateChangeRequest.update({
          where: { id: row.id },
          data: {
            status: "APPROVED",
            previousBps,
            checkerAdminId: req.adminId,
            decidedAt: now,
            appliedAt: null,
          },
        });
      }
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

    const { formatRatePair } = await import("../services/wht.js");
    await writeAudit({
      actorAdminId: req.adminId,
      action: body.approve ? "rate.approved" : "rate.rejected",
      entityType: "RateChangeRequest",
      entityId: row.id,
      after: {
        approve: body.approve,
        bandId: row.bandId,
        proposedBps: row.proposedBps,
        proposedRate: formatRatePair(row.proposedBps),
      },
    });

    res.json({ data: { id: row.id, status: body.approve ? "APPROVED" : "REJECTED" } });
  }),
);

adminRouter.get(
  "/rates/requests",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const { formatRatePair } = await import("../services/wht.js");
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
      data: rows.map((r) => {
        const currentBps = r.previousBps ?? r.band.rateBps;
        const currentPair = formatRatePair(currentBps);
        const proposedPair = formatRatePair(r.proposedBps);
        return {
          id: r.id,
          bandId: r.bandId,
          band: r.band.label,
          code: r.band.code,
          family: r.band.family,
          payout: r.band.payout,
          currentBps,
          proposedBps: r.proposedBps,
          currentRate: currentPair.netRatePct,
          proposedRate: proposedPair.netRatePct,
          currentGrossRate: currentPair.grossRatePct,
          proposedGrossRate: proposedPair.grossRatePct,
          currentRateLabel: currentPair.label,
          proposedRateLabel: proposedPair.label,
          effectiveFrom: r.effectiveFrom,
          reason: r.reason,
          status: r.status,
          appliedAt: r.appliedAt,
          submittedBy: byId[r.makerAdminId]?.name ?? r.makerAdminId,
          decidedBy: r.checkerAdminId ? (byId[r.checkerAdminId]?.name ?? r.checkerAdminId) : null,
          decidedAt: r.decidedAt,
          createdAt: r.createdAt,
        };
      }),
    });
  }),
);

adminRouter.get(
  "/support/tickets",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.supportTicket.findMany({
      include: { user: true, assigneeAdmin: { select: { id: true, name: true, email: true } } },
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
        user: {
          id: t.userId,
          name: `${t.user.firstName} ${t.user.surname}`,
          email: t.user.email,
        },
      })),
    });
  }),
);

adminRouter.post(
  "/support/tickets",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        userId: z.string().min(1),
        category: z.string().min(1).max(80),
        subject: z.string().min(1).max(160),
        body: z.string().min(1).max(4000),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
      })
      .parse(req.body);
    const customer = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!customer) throw new AppError(404, "User not found", "NOT_FOUND");
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: body.userId,
        category: body.category,
        subject: body.subject.trim(),
        body: body.body.trim(),
        priority: body.priority ?? "normal",
        messages: {
          create: {
            author: "SUPPORT",
            body: body.body.trim(),
          },
        },
      },
    });
    await notifyCustomer({
      userId: body.userId,
      title: "Support ticket opened",
      body: `We've opened “${ticket.subject}” for you. Check Help & support for updates.`,
      href: `/settings/help/tickets/${ticket.id}`,
      pushKind: "security",
    }).catch(() => undefined);
    await writeAudit({
      actorAdminId: req.adminId,
      action: "support.ticket.created",
      entityType: "SupportTicket",
      entityId: ticket.id,
      after: { userId: body.userId, subject: ticket.subject, priority: ticket.priority },
    });
    res.status(201).json({
      data: {
        id: ticket.id,
        status: ticket.status,
        priority: ticket.priority,
        subject: ticket.subject,
        category: ticket.category,
        createdAt: ticket.createdAt,
      },
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
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        adminNote: z.string().optional(),
        reply: z.string().min(1).max(4000).optional(),
        /** Real Team admin id — null clears assignee. */
        assigneeAdminId: z.string().nullable().optional(),
        attachmentUrl: z.string().min(8).max(500).optional(),
        attachmentName: z.string().min(1).max(160).optional(),
      })
      .parse(req.body);
    const existing = await prisma.supportTicket.findUnique({
      where: { id: String(req.params.id) },
      include: { user: true },
    });
    if (!existing) throw new AppError(404, "Ticket not found", "NOT_FOUND");

    let assigneeAdmin: { id: string; name: string; email: string } | null | undefined;
    if (body.assigneeAdminId !== undefined) {
      if (body.assigneeAdminId === null) {
        assigneeAdmin = null;
      } else {
        const admin = await prisma.adminUser.findFirst({
          where: { id: body.assigneeAdminId, active: true },
          select: { id: true, name: true, email: true },
        });
        if (!admin) throw new AppError(400, "Assignee not found or inactive", "ASSIGNEE_INVALID");
        assigneeAdmin = admin;
      }
    }

    const replyText = (body.reply ?? body.adminNote)?.trim();
    const attachmentUrl = body.attachmentUrl?.trim();
    const attachmentName = body.attachmentName?.trim() || undefined;
    if (attachmentUrl && !attachmentUrl.includes(`/uploads/support/${existing.userId}/`)) {
      throw new AppError(400, "Invalid attachment. Upload the file again.", "UPLOAD_INVALID");
    }
    if (attachmentUrl && !replyText) {
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
      await notifyCustomer({
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
        status:
          body.status ??
          (replyText || (body.assigneeAdminId !== undefined && body.assigneeAdminId)
            ? "IN_PROGRESS"
            : undefined),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.assigneeAdminId !== undefined
          ? { assigneeAdminId: body.assigneeAdminId }
          : {}),
      },
      include: {
        user: true,
        assigneeAdmin: { select: { id: true, name: true, email: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    if (
      assigneeAdmin &&
      assigneeAdmin.id !== existing.assigneeAdminId &&
      assigneeAdmin.id !== req.adminId
    ) {
      const assigner = req.adminId
        ? await prisma.adminUser.findUnique({
            where: { id: req.adminId },
            select: { name: true },
          })
        : null;
      await sendTicketAssignedEmail({
        to: assigneeAdmin.email,
        assigneeName: assigneeAdmin.name,
        subject: row.subject,
        ticketId: row.id,
        customerName: `${row.user.firstName} ${row.user.surname}`.trim(),
        assignedBy: assigner?.name,
      }).catch((err) => console.warn("[ticket-assign-email]", err));
    }

    await writeAudit({
      actorAdminId: req.adminId,
      action: "support.ticket.updated",
      entityType: "SupportTicket",
      entityId: row.id,
      after: {
        status: row.status,
        priority: row.priority,
        replied: Boolean(replyText),
        assigneeAdminId: row.assigneeAdminId,
        assigneeName: row.assigneeAdmin?.name ?? null,
      },
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
        assigneeAdminId: row.assigneeAdminId,
        assignee: row.assigneeAdmin
          ? { id: row.assigneeAdmin.id, name: row.assigneeAdmin.name, email: row.assigneeAdmin.email }
          : null,
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

adminRouter.get(
  "/products/categories",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.productCategory.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({ data: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name })) });
  }),
);

adminRouter.get(
  "/products",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const includeArchived =
      req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const rows = await prisma.product.findMany({
      where: includeArchived ? undefined : { archivedAt: null },
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
        ratePct: p.rateBps / 10000,
        tenorDays: p.tenorDays,
        minimum: koboToNaira(p.minimumKobo),
        availability: p.availability,
        archivedAt: p.archivedAt,
        issuer: p.issuer,
        largeTicket: p.largeTicket,
        category: { id: p.categoryId, slug: p.category.slug, name: p.category.name },
        createdAt: p.createdAt,
        details: asProductDetails(p.details),
      })),
    });
  }),
);

adminRouter.post(
  "/products",
  requireAdmin,
  requirePermission("product.manage"),
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        categoryId: z.string().optional(),
        categoryName: z.string().optional(),
        slug: z.string().min(2).optional(),
        name: z.string().min(2),
        blurb: z.string().min(2).optional(),
        description: z.string().min(10).optional(),
        rateBps: z.number().int().positive().optional(),
        ratePct: z.number().positive().optional(),
        grossRatePct: z.number().positive().optional(),
        whtRatePct: z.number().min(0).max(100).optional(),
        tenorDays: z.number().int().positive(),
        minimum: z.number().positive(),
        availability: z.enum(["OPEN", "CLOSING", "CLOSED", "COMING_SOON"]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
        details: productDetailsSchema,
      })
      .parse(req.body);

    let categoryId = body.categoryId;
    if (!categoryId) {
      const name = body.categoryName?.trim() || "Fixed Income";
      const catSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const cat = await prisma.productCategory.upsert({
        where: { slug: catSlug },
        create: { slug: catSlug, name, sortOrder: 99 },
        update: {},
      });
      categoryId = cat.id;
    }

    const whtPct = body.whtRatePct ?? 10;
    let rateBps =
      body.rateBps ??
      (body.ratePct != null ? Math.round(body.ratePct * 10000) : undefined);
    if (rateBps == null && body.grossRatePct != null) {
      const netPct = body.grossRatePct * (1 - whtPct / 100);
      rateBps = Math.round(netPct * 10000);
    }
    if (rateBps == null) throw new AppError(400, "rateBps, ratePct or grossRatePct required", "RATE_REQUIRED");

    const slug =
      body.slug?.trim() ||
      `${body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48)}-${Date.now().toString(36).slice(-4)}`;

    const row = await prisma.product.create({
      data: {
        categoryId,
        slug,
        name: body.name,
        blurb: body.blurb ?? body.name,
        description: body.description,
        details: toPrismaJson(body.details),
        rateBps,
        whtRatePct: whtPct,
        tenorDays: body.tenorDays,
        minimumKobo: BigInt(Math.round(body.minimum * 100)),
        availability: body.availability ?? "OPEN",
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
    res.status(201).json({
      data: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        ratePct: row.rateBps / 10000,
        tenorDays: row.tenorDays,
        minimum: koboToNaira(row.minimumKobo),
        availability: row.availability,
        description: row.description,
        details: asProductDetails(row.details),
      },
    });
  }),
);

adminRouter.patch(
  "/products/:id",
  requireAdmin,
  requirePermission("product.manage"),
  asyncHandler(async (req: AdminRequest, res) => {
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
        archivedAt: z.union([z.string().datetime(), z.null()]).optional(),
        issuer: z.string().optional(),
        largeTicket: z.boolean().optional(),
        details: productDetailsSchema,
      })
      .parse(req.body);
    const rateBps =
      body.rateBps ?? (body.ratePct != null ? Math.round(body.ratePct * 10000) : undefined);
    const archivedAt =
      body.archivedAt === undefined
        ? undefined
        : body.archivedAt === null
          ? null
          : new Date(body.archivedAt);
    const row = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: {
        name: body.name,
        blurb: body.blurb,
        description: body.description,
        details: body.details !== undefined ? toPrismaJson(body.details) : undefined,
        rateBps,
        tenorDays: body.tenorDays,
        minimumKobo:
          body.minimum !== undefined ? BigInt(Math.round(body.minimum * 100)) : undefined,
        availability: body.availability,
        archivedAt,
        issuer: body.issuer,
        largeTicket: body.largeTicket,
      },
      include: { category: true },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: archivedAt ? "product.archived" : "product.updated",
      entityType: "Product",
      entityId: row.id,
    });
    res.json({
      data: {
        id: row.id,
        name: row.name,
        ratePct: row.rateBps / 10000,
        tenorDays: row.tenorDays,
        minimum: koboToNaira(row.minimumKobo),
        availability: row.availability,
        archivedAt: row.archivedAt,
        description: row.description,
        details: asProductDetails(row.details),
      },
    });
  }),
);

adminRouter.get(
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
    const rows = await prisma.adminUser.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        sessions: {
          where: { revokedAt: null },
          orderBy: { lastActiveAt: "desc" },
          take: 1,
          select: { lastActiveAt: true },
        },
      },
    });
    res.json({
      data: rows.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        role: a.role,
        active: a.active,
        department: a.department,
        phone: a.phone,
        invitePending: a.invitePending,
        require2fa: a.require2fa,
        makerChecker: a.makerChecker,
        createdAt: a.createdAt,
        lastActiveAt: a.sessions[0]?.lastActiveAt ?? null,
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
        password: z.string().min(8).optional(),
        pin: z.string().length(4).regex(/^\d{4}$/).optional(),
        department: z.string().max(120).optional(),
        phone: z.string().max(32).optional(),
        require2fa: z.boolean().optional(),
        makerChecker: z.boolean().optional(),
      })
      .parse(req.body);
    const email = body.email.toLowerCase().trim();
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new AppError(409, "Email already in use", "EMAIL_EXISTS");

    const tempPassword = body.password ?? `Kp${nanoid(10)}!`;
    assertAdminPasswordRules(tempPassword);
    const tempPin = body.pin ?? String(1000 + Math.floor(Math.random() * 9000));
    const passwordHash = await hashSecret(tempPassword);
    const pinHash = await hashSecret(tempPin);
    const row = await prisma.adminUser.create({
      data: {
        email,
        name: body.name.trim(),
        role: body.role,
        passwordHash,
        pinHash,
        department: body.department?.trim() || null,
        phone: body.phone?.replace(/\D/g, "") || null,
        invitePending: true,
        require2fa: body.require2fa ?? true,
        makerChecker: body.makerChecker ?? false,
        active: true,
      },
    });
    await sendAdminInviteEmail({
      to: email,
      name: row.name,
      tempPassword,
      role: row.role,
    }).catch((err) => console.warn("[admin-invite-email]", err));
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.created",
      entityType: "AdminUser",
      entityId: row.id,
    });
    res.status(201).json({
      data: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        active: row.active,
        department: row.department,
        phone: row.phone,
        invitePending: row.invitePending,
        require2fa: row.require2fa,
        makerChecker: row.makerChecker,
        tempPassword,
        tempPin,
      },
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
        department: z.string().optional(),
        phone: z.string().optional(),
        require2fa: z.boolean().optional(),
        makerChecker: z.boolean().optional(),
        invitePending: z.boolean().optional(),
      })
      .parse(req.body);

    const targetId = String(req.params.id);
    if (body.role != null) {
      assertSuperAdmin(req);
      if (targetId === req.adminId) {
        throw new AppError(400, "You cannot change your own role", "SELF_ROLE_CHANGE");
      }
    }

    const data = {
      ...body,
      ...(body.phone !== undefined ? { phone: body.phone.replace(/\D/g, "") || null } : {}),
    };
    const row = await prisma.adminUser.update({
      where: { id: targetId },
      data,
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.updated",
      entityType: "AdminUser",
      entityId: row.id,
      after: body,
    });
    res.json({
      data: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        active: row.active,
        department: row.department,
        phone: row.phone,
        invitePending: row.invitePending,
        require2fa: row.require2fa,
        makerChecker: row.makerChecker,
      },
    });
  }),
);

adminRouter.post(
  "/team/:id/reset-password",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const admin = await prisma.adminUser.findUnique({ where: { id: String(req.params.id) } });
    if (!admin) throw new AppError(404, "Admin not found", "NOT_FOUND");
    const tempPassword = `Kp${nanoid(10)}!`;
    assertAdminPasswordRules(tempPassword);
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashSecret(tempPassword), invitePending: true },
    });
    await sendAdminInviteEmail({
      to: admin.email,
      name: admin.name,
      tempPassword,
      role: admin.role,
    }).catch((err) => console.warn("[admin-reset-email]", err));
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.password_reset",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({ data: { sent: true } });
  }),
);

adminRouter.post(
  "/team/:id/reset-2fa",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const admin = await prisma.adminUser.findUnique({ where: { id: String(req.params.id) } });
    if (!admin) throw new AppError(404, "Admin not found", "NOT_FOUND");
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        pinHash: null,
        require2fa: true,
        totpEnabled: false,
        totpSecretEnc: null,
        totpPendingEnc: null,
        totpConfirmedAt: null,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.2fa_reset",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({ data: { reset: true } });
  }),
);

adminRouter.delete(
  "/team/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const id = String(req.params.id);
    if (id === req.adminId) {
      throw new AppError(400, "You cannot remove your own account", "SELF_DELETE");
    }
    const admin = await prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new AppError(404, "Admin not found", "NOT_FOUND");
    await prisma.adminSession.updateMany({
      where: { adminId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.adminUser.update({
      where: { id },
      data: { active: false, invitePending: false },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.removed",
      entityType: "AdminUser",
      entityId: id,
    });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/me",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    const { permissionsForRole } = await import("../services/admin-permissions.js");
    const { getAdminAlertPrefs } = await import("../services/admin-alerts.js");
    const permissions = await permissionsForRole(admin.role);
    const alertPrefs = await getAdminAlertPrefs(admin.id);
    res.json({
      data: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        phone: admin.phone,
        require2fa: admin.require2fa,
        totpEnabled: admin.totpEnabled,
        makerChecker: admin.makerChecker,
        permissions,
        alertPrefs,
      },
    });
  }),
);

adminRouter.patch(
  "/me",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        phone: z.string().max(32).optional(),
        alertPrefs: z
          .object({
            withdrawalApprovals: z.boolean().optional(),
            amlEscalations: z.boolean().optional(),
            reconVariances: z.boolean().optional(),
            rateApprovals: z.boolean().optional(),
            dailyOpsDigest: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const row = await prisma.adminUser.update({
      where: { id: req.adminId! },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.replace(/\D/g, "") || null } : {}),
      },
    });
    let alertPrefs;
    if (body.alertPrefs) {
      const { setAdminAlertPrefs } = await import("../services/admin-alerts.js");
      alertPrefs = await setAdminAlertPrefs(req.adminId!, body.alertPrefs);
    } else {
      const { getAdminAlertPrefs } = await import("../services/admin-alerts.js");
      alertPrefs = await getAdminAlertPrefs(req.adminId!);
    }
    res.json({
      data: {
        id: row.id,
        name: row.name,
        phone: row.phone,
        email: row.email,
        role: row.role,
        alertPrefs,
      },
    });
  }),
);

adminRouter.post(
  "/me/password",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
      })
      .parse(req.body);
    assertAdminPasswordRules(body.newPassword);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    const ok = await verifySecret(body.currentPassword, admin.passwordHash);
    if (!ok) throw new AppError(401, "Current password is incorrect", "PASSWORD_INVALID");
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashSecret(body.newPassword), invitePending: false },
    });
    await prisma.adminSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.password_changed",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({ data: { ok: true } });
  }),
);

/** Start authenticator enrollment — returns otpauth URI + secret for Google Authenticator. */
adminRouter.post(
  "/me/2fa/setup",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    const {
      generateTotpSecret,
      encryptTotpSecret,
      totpKeyUri,
      formatTotpSecretDisplay,
    } = await import("../services/admin-totp.js");
    const secret = generateTotpSecret();
    const otpauthUrl = totpKeyUri(admin.email, secret);
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpPendingEnc: encryptTotpSecret(secret) },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.2fa.setup_started",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({
      data: {
        secret,
        secretDisplay: formatTotpSecretDisplay(secret),
        otpauthUrl,
        issuer: "Kipit Admin",
        account: admin.email,
        replacing: admin.totpEnabled,
      },
    });
  }),
);

/** Confirm enrollment with a 6-digit authenticator code. */
adminRouter.post(
  "/me/2fa/confirm",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    if (!admin.totpPendingEnc) {
      throw new AppError(400, "Start authenticator setup first", "TOTP_SETUP_REQUIRED");
    }
    const { decryptTotpSecret, verifyTotpCode, encryptTotpSecret } = await import(
      "../services/admin-totp.js"
    );
    let secret: string;
    try {
      secret = decryptTotpSecret(admin.totpPendingEnc);
    } catch {
      throw new AppError(400, "Setup expired — start again", "TOTP_SETUP_INVALID");
    }
    if (!verifyTotpCode(secret, body.code.trim())) {
      throw new AppError(401, "Invalid authenticator code", "TOTP_INVALID");
    }
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        totpSecretEnc: encryptTotpSecret(secret),
        totpPendingEnc: null,
        totpEnabled: true,
        totpConfirmedAt: new Date(),
        require2fa: true,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.2fa.enabled",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({ data: { totpEnabled: true } });
  }),
);

/** Disable authenticator — requires password + current code. */
adminRouter.post(
  "/me/2fa/disable",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const body = z
      .object({
        password: z.string().min(1),
        code: z.string().min(6).max(8),
      })
      .parse(req.body);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.adminId! } });
    if (!(await verifySecret(body.password, admin.passwordHash))) {
      throw new AppError(401, "Incorrect password", "PASSWORD_INVALID");
    }
    if (!admin.totpEnabled || !admin.totpSecretEnc) {
      throw new AppError(400, "Authenticator is not enabled", "TOTP_NOT_ENABLED");
    }
    const { decryptTotpSecret, verifyTotpCode } = await import("../services/admin-totp.js");
    const secret = decryptTotpSecret(admin.totpSecretEnc);
    if (!verifyTotpCode(secret, body.code.trim())) {
      throw new AppError(401, "Invalid authenticator code", "TOTP_INVALID");
    }
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        totpEnabled: false,
        totpSecretEnc: null,
        totpPendingEnc: null,
        totpConfirmedAt: null,
        require2fa: false,
      },
    });
    await writeAudit({
      actorAdminId: req.adminId,
      action: "admin.2fa.disabled",
      entityType: "AdminUser",
      entityId: admin.id,
    });
    res.json({ data: { totpEnabled: false } });
  }),
);

adminRouter.get(
  "/audit",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        actorUser: { select: { id: true, email: true, firstName: true, surname: true } },
      },
    });

    const adminIds = [
      ...new Set(rows.map((r) => r.actorAdminId).filter((id): id is string => Boolean(id))),
    ];
    const userEntityIds = [
      ...new Set(
        rows
          .filter((r) => r.entityType === "User" && r.entityId)
          .map((r) => r.entityId as string),
      ),
    ];

    const [admins, entityUsers] = await Promise.all([
      adminIds.length
        ? prisma.adminUser.findMany({
            where: { id: { in: adminIds } },
            select: { id: true, email: true, name: true, role: true },
          })
        : Promise.resolve([]),
      userEntityIds.length
        ? prisma.user.findMany({
            where: { id: { in: userEntityIds } },
            select: { id: true, email: true, firstName: true, surname: true },
          })
        : Promise.resolve([]),
    ]);

    const adminById = new Map(admins.map((a) => [a.id, a]));
    const userById = new Map(entityUsers.map((u) => [u.id, u]));

    res.json({
      data: rows.map((r) => {
        const admin = r.actorAdminId ? adminById.get(r.actorAdminId) : undefined;
        const actorUser = r.actorUser;
        const entityUser =
          r.entityType === "User" && r.entityId ? userById.get(r.entityId) : undefined;
        const actorEmail = admin?.email ?? actorUser?.email ?? null;
        const actorName =
          admin?.name ??
          ([actorUser?.firstName, actorUser?.surname].filter(Boolean).join(" ") || null);
        return {
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actorAdminId: r.actorAdminId,
          actorUserId: r.actorUserId,
          actorEmail,
          actorName,
          actorRole: admin?.role ?? null,
          entityEmail: entityUser?.email ?? null,
          entityLabel:
            entityUser?.email ??
            (r.entityType && r.entityId ? `${r.entityType} · ${r.entityId.slice(0, 8)}` : null),
          before: r.before,
          after: r.after,
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
          createdAt: r.createdAt,
        };
      }),
    });
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
