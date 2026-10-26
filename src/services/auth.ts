import { OtpPurpose } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { AppError } from "../lib/errors.js";
import {
  hashSecret,
  makeReferralCode,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  verifySecret,
  weakPin,
} from "../lib/crypto.js";
import { ensureUserWallet } from "./ledger.js";
import { writeAudit } from "./audit.js";
import { emailTransportReady, sendOtpEmail } from "./email.js";

function otpCode() {
  // Fixed demo OTP only when no real email transport is configured (local/dev).
  if (env.NODE_ENV === "development" && !emailTransportReady()) return env.DEMO_OTP;
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function requestOtp(input: {
  target: string;
  purpose: OtpPurpose;
  userId?: string;
}) {
  const target = input.target.toLowerCase();

  // #8 — Never email reset codes to addresses that are not registered.
  // Still return a generic success payload so callers cannot enumerate accounts.
  if (input.purpose === "PASSWORD_RESET" || input.purpose === "PIN_RESET") {
    const existing = await prisma.user.findUnique({
      where: { email: target },
      select: { id: true },
    });
    if (!existing) {
      return {
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        sent: true,
      };
    }
    input = { ...input, userId: input.userId ?? existing.id };
  }

  const code = otpCode();
  const codeHash = await hashSecret(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.otpChallenge.create({
    data: {
      target,
      purpose: input.purpose,
      userId: input.userId,
      codeHash,
      expiresAt,
    },
  });

  // Email targets only — phone OTP can be added later via SMS.
  if (target.includes("@")) {
    try {
      await sendOtpEmail({ to: target, code, purpose: input.purpose });
    } catch (err) {
      console.error("[email] failed to send OTP:", err);
      // Still return success so attackers cannot probe mail delivery; code remains valid in DB.
    }
  }

  return {
    expiresAt,
    sent: true,
    ...(env.NODE_ENV === "development" && !emailTransportReady() ? { debugCode: code } : {}),
  };
}

async function findOtpChallenge(input: {
  target: string;
  purpose: OtpPurpose;
  code: string;
}) {
  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      target: input.target.toLowerCase(),
      purpose: input.purpose,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!challenge || challenge.expiresAt < new Date()) {
    throw new AppError(400, "OTP expired or not found", "OTP_INVALID");
  }
  if (challenge.attempts >= 5) {
    throw new AppError(429, "Too many OTP attempts", "OTP_LOCKED");
  }

  const ok = await verifySecret(input.code, challenge.codeHash);
  if (!ok) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError(400, "Invalid OTP", "OTP_INVALID");
  }

  return challenge;
}

/** Validate OTP without consuming — for multi-step reset flows. */
export async function checkOtp(input: {
  target: string;
  purpose: OtpPurpose;
  code: string;
}) {
  return findOtpChallenge(input);
}

export async function verifyOtp(input: {
  target: string;
  purpose: OtpPurpose;
  code: string;
}) {
  const challenge = await findOtpChallenge(input);

  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  return challenge;
}

export async function registerUser(input: {
  email: string;
  password: string;
  firstName: string;
  middleName?: string;
  surname: string;
  referralCode?: string;
  biometricsLogin?: boolean;
  biometricsTxn?: boolean;
  dateOfBirth?: string;
  phone?: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  const email = input.email.toLowerCase().trim();
  const phone = input.phone?.trim() || null;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "Email already registered", "EMAIL_EXISTS");
  if (phone) {
    const phoneTaken = await prisma.user.findFirst({ where: { phone } });
    if (phoneTaken) {
      throw new AppError(409, "Phone number already registered", "PHONE_EXISTS");
    }
  }

  const passwordHash = await hashSecret(input.password);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        middleName: input.middleName?.trim(),
        surname: input.surname.trim(),
        phone,
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
        referralCode: makeReferralCode(input.firstName),
        referredBy: input.referralCode?.trim() || null,
        biometricsLogin: input.biometricsLogin ?? false,
        biometricsTxn: input.biometricsTxn ?? false,
        consents: {
          create: [
            { docKey: "terms", version: "1.0" },
            { docKey: "privacy", version: "1.0" },
          ],
        },
      },
    });
  } catch (err: unknown) {
    const meta = (err as { code?: string; meta?: { target?: string[] } }) ?? {};
    if (meta.code === "P2002") {
      const target = meta.meta?.target ?? [];
      if (target.includes("phone")) {
        throw new AppError(409, "Phone number already registered", "PHONE_EXISTS");
      }
      if (target.includes("email")) {
        throw new AppError(409, "Email already registered", "EMAIL_EXISTS");
      }
    }
    throw err;
  }

  await ensureUserWallet(user.id);
  await prisma.notificationPref.create({
    data: { userId: user.id },
  }).catch(() => undefined);
  await writeAudit({
    actorUserId: user.id,
    action: "user.register",
    entityType: "User",
    entityId: user.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  if (user.email) {
    const { sendWelcomeEmail } = await import("./notify.js");
    await sendWelcomeEmail({
      to: user.email,
      firstName: user.firstName,
      accountType: "PERSONAL",
    }).catch((err) => console.warn("[welcome-email]", err));
    const { logSignupStep } = await import("./signup-funnel.js");
    await logSignupStep({
      step: "complete",
      email: user.email,
      completed: true,
      metadata: { userId: user.id },
    }).catch(() => undefined);
  }

  // Non-app recipients: gift lands in portfolio once they register with gifted phone/email.
  {
    const { claimPendingGiftsForUser } = await import("./gifts.js");
    await claimPendingGiftsForUser(user.id).catch((err) =>
      console.warn("[gift-auto-claim]", err),
    );
  }

  return user;
}

export async function setTransactionPin(userId: string, pin: string) {
  const reason = weakPin(pin);
  if (reason) throw new AppError(400, reason, "WEAK_PIN");
  const pinHash = await hashSecret(pin);
  return prisma.user.update({
    where: { id: userId },
    data: { pinHash },
  });
}

export async function verifyTransactionPin(userId: string, pin: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.pinHash) throw new AppError(400, "PIN not set", "PIN_MISSING");
  const ok = await verifySecret(pin, user.pinHash);
  if (!ok) throw new AppError(401, "Incorrect PIN", "PIN_INVALID");
  return true;
}

export async function createSession(input: {
  userId: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  if (user.frozen) {
    throw new AppError(403, "This account is frozen. Contact support.", "ACCOUNT_FROZEN");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, "Account temporarily locked", "ACCOUNT_LOCKED");
  }

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      refreshTokenHash: "pending",
      deviceName: input.deviceName,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    },
  });

  const accessToken = signAccessToken(user.id, session.id);
  const refreshToken = signRefreshToken(user.id, session.id);
  const refreshTokenHash = await hashSecret(refreshToken);

  await prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  return {
    user: publicUser(user),
    accessToken,
    refreshToken,
    sessionId: session.id,
  };
}

function splitGoogleName(payload: {
  given_name?: string;
  family_name?: string;
  name?: string;
}) {
  const given = payload.given_name?.trim();
  const family = payload.family_name?.trim();
  if (given || family) {
    return {
      firstName: given || family || "Kipit",
      surname: family || given || "User",
    };
  }
  const parts = (payload.name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Kipit", surname: "User" };
  if (parts.length === 1) return { firstName: parts[0]!, surname: parts[0]! };
  return { firstName: parts[0]!, surname: parts.slice(1).join(" ") };
}

/** Sign in or register via Google Identity Services ID token (web). */
export async function loginWithGoogleIdToken(input: {
  idToken: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    throw new AppError(503, "Google sign-in is not configured", "GOOGLE_NOT_CONFIGURED");
  }

  const { OAuth2Client } = await import("google-auth-library");
  const client = new OAuth2Client(clientId);
  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: input.idToken,
      audience: clientId,
    });
  } catch {
    throw new AppError(401, "Google sign-in failed. Try again.", "GOOGLE_TOKEN_INVALID");
  }

  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new AppError(401, "Google sign-in failed. Try again.", "GOOGLE_TOKEN_INVALID");
  }
  if (!payload.email || payload.email_verified === false) {
    throw new AppError(
      400,
      "Your Google account email must be verified to continue.",
      "GOOGLE_EMAIL_UNVERIFIED",
    );
  }

  const email = payload.email.toLowerCase().trim();
  const googleSub = payload.sub;
  const { firstName, surname } = splitGoogleName(payload);

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleSub }, { email }] },
  });

  if (user?.frozen) {
    throw new AppError(403, "This account is frozen. Contact support.", "ACCOUNT_FROZEN");
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        googleSub,
        firstName,
        surname,
        passwordHash: null,
        referralCode: makeReferralCode(firstName),
        consents: {
          create: [
            { docKey: "terms", version: "1.0" },
            { docKey: "privacy", version: "1.0" },
          ],
        },
      },
    });
    await ensureUserWallet(user.id).catch(() => undefined);
    await writeAudit({
      actorUserId: user.id,
      action: "user.register.google",
      entityType: "User",
      entityId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  } else if (!user.googleSub) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { googleSub },
    });
  } else if (user.googleSub !== googleSub) {
    throw new AppError(409, "This email is linked to a different Google account.", "GOOGLE_SUB_MISMATCH");
  }

  const priorActive = await prisma.session.count({
    where: { userId: user.id, revokedAt: null },
  });

  const session = await createSession({
    userId: user.id,
    deviceName: input.deviceName,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  await writeAudit({
    actorUserId: user.id,
    action: "user.login.google",
    entityType: "Session",
    entityId: session.sessionId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  if (priorActive > 0) {
    const { createUserNotification } = await import("./notify.js");
    const deviceLabel = input.deviceName?.trim() || "another device";
    await createUserNotification({
      userId: user.id,
      title: "New sign-in",
      body: `Your Kipit account was signed in on ${deviceLabel}. If this wasn’t you, review your sessions.`,
      href: "/settings/security",
      pushKind: "security",
    }).catch(() => undefined);
  }

  {
    const { claimPendingGiftsForUser } = await import("./gifts.js");
    await claimPendingGiftsForUser(user.id).catch((err) =>
      console.warn("[gift-auto-claim]", err),
    );
  }

  return session;
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}) {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) {
    throw new AppError(401, "Invalid email or password", "AUTH_FAILED");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, "Account temporarily locked", "ACCOUNT_LOCKED");
  }

  const ok = await verifySecret(input.password, user.passwordHash);
  if (!ok) {
    const failedLoginCount = user.failedLoginCount + 1;
    const lockedUntil = failedLoginCount >= 3 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil },
    });
    throw new AppError(401, "Invalid email or password", "AUTH_FAILED");
  }

  const priorActive = await prisma.session.count({
    where: { userId: user.id, revokedAt: null },
  });

  const session = await createSession({
    userId: user.id,
    deviceName: input.deviceName,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  await writeAudit({
    actorUserId: user.id,
    action: "user.login",
    entityType: "Session",
    entityId: session.sessionId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  // Security alert only when another session was already active (new / second device).
  if (priorActive > 0) {
    const { createUserNotification } = await import("./notify.js");
    const deviceLabel = input.deviceName?.trim() || "another device";
    await createUserNotification({
      userId: user.id,
      title: "New sign-in",
      body: `Your Kipit account was signed in on ${deviceLabel}. If this wasn’t you, change your password and review sessions.`,
      href: "/settings/security",
      pushKind: "security",
    }).catch(() => undefined);
  }

  {
    const { claimPendingGiftsForUser } = await import("./gifts.js");
    await claimPendingGiftsForUser(user.id).catch((err) =>
      console.warn("[gift-auto-claim]", err),
    );
  }

  return session;
}

export async function revokeSession(sessionId: string, userId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, revokedAt: null },
  });
  if (!session) throw new AppError(404, "Session not found", "SESSION_NOT_FOUND");
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

/** Rotate refresh token and issue a new access token. */
export async function refreshSession(refreshToken: string) {
  let claims: { sub: string; sid: string };
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "Invalid refresh token", "REFRESH_INVALID");
  }

  const session = await prisma.session.findFirst({
    where: { id: claims.sid, userId: claims.sub, revokedAt: null },
  });
  if (!session) throw new AppError(401, "Session revoked", "SESSION_REVOKED");

  const ok = await verifySecret(refreshToken, session.refreshTokenHash);
  if (!ok) throw new AppError(401, "Invalid refresh token", "REFRESH_INVALID");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: claims.sub } });
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, "Account temporarily locked", "ACCOUNT_LOCKED");
  }

  const accessToken = signAccessToken(user.id, session.id);
  const nextRefresh = signRefreshToken(user.id, session.id);
  const refreshTokenHash = await hashSecret(nextRefresh);

  await prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash, lastActiveAt: new Date() },
  });

  return {
    user: publicUser(user),
    accessToken,
    refreshToken: nextRefresh,
    sessionId: session.id,
  };
}

export async function resetPasswordWithOtp(input: {
  target: string;
  code: string;
  password: string;
}) {
  if (input.password.length < 8) {
    throw new AppError(400, "Password must be at least 8 characters", "WEAK_PASSWORD");
  }
  await verifyOtp({
    target: input.target,
    purpose: "PASSWORD_RESET",
    code: input.code,
  });
  const email = input.target.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError(404, "Account not found", "USER_NOT_FOUND");

  const passwordHash = await hashSecret(input.password);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
  });
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await writeAudit({
    actorUserId: user.id,
    action: "user.password_reset",
    entityType: "User",
    entityId: user.id,
  });
  const { createUserNotification } = await import("./notify.js");
  await createUserNotification({
    userId: user.id,
    title: "Password changed",
    body: "Your Kipit password was reset. All other sessions were signed out. If this wasn’t you, contact support immediately.",
    href: "/settings/security",
    pushKind: "security",
  }).catch(() => undefined);
  return { ok: true as const };
}

export function publicUser(user: {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string;
  middleName: string | null;
  surname: string;
  kycTier: string;
  referralCode: string;
  biometricsLogin: boolean;
  biometricsTxn: boolean;
  pinHash: string | null;
  createdAt: Date;
  frozen?: boolean;
  frozenReason?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    middleName: user.middleName,
    surname: user.surname,
    kycTier: user.kycTier,
    referralCode: user.referralCode,
    biometricsLogin: user.biometricsLogin,
    biometricsTxn: user.biometricsTxn,
    hasPin: Boolean(user.pinHash),
    frozen: Boolean(user.frozen),
    frozenReason: user.frozenReason ?? null,
    createdAt: user.createdAt,
  };
}
