import { OtpPurpose } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { AppError } from "../lib/errors.js";
import {
  hashSecret,
  makeReferralCode,
  signAccessToken,
  signRefreshToken,
  verifySecret,
  weakPin,
} from "../lib/crypto.js";
import { ensureUserWallet } from "./ledger.js";
import { writeAudit } from "./audit.js";
import { sendOtpEmail } from "./email.js";

function otpCode() {
  // Fixed demo OTP only when SMTP is not configured (local/dev convenience).
  if (env.NODE_ENV === "development" && !env.SMTP_HOST) return env.DEMO_OTP;
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function requestOtp(input: {
  target: string;
  purpose: OtpPurpose;
  userId?: string;
}) {
  const code = otpCode();
  const codeHash = await hashSecret(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const target = input.target.toLowerCase();

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
    ...(env.NODE_ENV === "development" && !env.SMTP_HOST ? { debugCode: code } : {}),
  };
}

export async function verifyOtp(input: {
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
  ipAddress?: string;
  userAgent?: string;
}) {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "Email already registered", "EMAIL_EXISTS");

  const passwordHash = await hashSecret(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: input.firstName.trim(),
      middleName: input.middleName?.trim(),
      surname: input.surname.trim(),
      referralCode: makeReferralCode(input.firstName),
      referredBy: input.referralCode?.trim() || null,
      consents: {
        create: [
          { docKey: "terms", version: "1.0" },
          { docKey: "privacy", version: "1.0" },
        ],
      },
    },
  });

  await ensureUserWallet(user.id);
  await writeAudit({
    actorUserId: user.id,
    action: "user.register",
    entityType: "User",
    entityId: user.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

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
    createdAt: user.createdAt,
  };
}
