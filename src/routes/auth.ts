import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createSession,
  loginWithPassword,
  publicUser,
  refreshSession,
  registerUser,
  requestOtp,
  resetPasswordWithOtp,
  revokeSession,
  setTransactionPin,
  verifyOtp,
} from "../services/auth.js";
import { prisma } from "../lib/prisma.js";
import { getWalletBalanceKobo } from "../services/ledger.js";
import { koboToNaira } from "../lib/crypto.js";

export const authRouter = Router();

authRouter.post(
  "/funnel",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        step: z.string().min(1).max(40),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        deviceId: z.string().optional(),
        completed: z.boolean().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    const { logSignupStep } = await import("../services/signup-funnel.js");
    const row = await logSignupStep(body);
    res.status(201).json({ data: { id: row?.id ?? null, ok: true } });
  }),
);

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        firstName: z.string().min(1),
        middleName: z.string().optional(),
        surname: z.string().min(1),
        referralCode: z.string().optional(),
        biometricsLogin: z.boolean().optional(),
        biometricsTxn: z.boolean().optional(),
        dateOfBirth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        phone: z.string().min(7).max(20).optional(),
      })
      .parse(req.body);

    const user = await registerUser({
      ...body,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });

    const otp = await requestOtp({
      target: body.email,
      purpose: "SIGNUP",
      userId: user.id,
    });

    res.status(201).json({
      data: {
        user: publicUser(user),
        otp,
      },
    });
  }),
);

authRouter.post(
  "/otp/request",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        target: z.string().min(3),
        purpose: z.enum(["SIGNUP", "LOGIN", "PASSWORD_RESET", "PIN_RESET"]),
      })
      .parse(req.body);

    const otp = await requestOtp({
      target: body.target,
      purpose: body.purpose,
    });

    res.json({ data: otp });
  }),
);

authRouter.post(
  "/otp/verify",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        target: z.string().min(3),
        purpose: z.enum(["SIGNUP", "LOGIN", "PASSWORD_RESET", "PIN_RESET"]),
        code: z.string().min(4).max(8),
      })
      .parse(req.body);

    await verifyOtp(body);
    res.json({ data: { verified: true } });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
        deviceName: z.string().optional(),
      })
      .parse(req.body);

    const session = await loginWithPassword({
      ...body,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });

    res.json({ data: session });
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const body = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
    const session = await refreshSession(body.refreshToken);
    res.json({ data: session });
  }),
);

authRouter.post(
  "/password/reset",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        target: z.string().min(3),
        code: z.string().min(4).max(8),
        password: z.string().min(8),
      })
      .parse(req.body);

    await resetPasswordWithOtp(body);
    res.json({ data: { ok: true } });
  }),
);

authRouter.post(
  "/pin",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        pin: z.string().length(4),
        confirmPin: z.string().length(4),
      })
      .parse(req.body);

    if (body.pin !== body.confirmPin) {
      return res.status(400).json({
        error: { message: "PINs do not match", code: "PIN_MISMATCH" },
      });
    }

    const user = await setTransactionPin(req.userId!, body.pin);
    res.json({ data: { user: publicUser(user) } });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const walletKobo = await getWalletBalanceKobo(user.id);
    res.json({
      data: {
        user: publicUser(user),
        wallet: {
          currency: "NGN",
          balanceKobo: walletKobo.toString(),
          balance: koboToNaira(walletKobo),
        },
      },
    });
  }),
);

authRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.userId!, revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
      select: {
        id: true,
        deviceName: true,
        userAgent: true,
        ipAddress: true,
        lastActiveAt: true,
        createdAt: true,
      },
    });
    res.json({
      data: {
        currentSessionId: req.sessionId,
        sessions,
      },
    });
  }),
);

authRouter.delete(
  "/sessions/:sessionId",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    await revokeSession(String(req.params.sessionId), req.userId!);
    res.status(204).send();
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    await revokeSession(req.sessionId!, req.userId!);
    res.status(204).send();
  }),
);

/** Dev helper: issue session after register without full OTP UI. */
authRouter.post(
  "/dev/session",
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: { message: "Not found" } });
    }
    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    const session = await createSession({
      userId: body.userId,
      deviceName: "dev",
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip,
    });
    res.json({ data: session });
  }),
);
