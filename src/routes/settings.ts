import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { publicUser, setTransactionPin, verifyTransactionPin } from "../services/auth.js";
import { revokeSession } from "../services/auth.js";

export const settingsRouter = Router();

settingsRouter.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    res.json({
      data: {
        ...publicUser(user),
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        occupation: user.occupation,
        employmentStatus: user.employmentStatus,
        sourceOfFunds: user.sourceOfFunds,
        address: {
          street: user.addressStreet,
          city: user.addressCity,
          state: user.addressState,
          lga: user.addressLga,
          pending: user.addressPending,
        },
        lockedFields: user.kycTier !== "TIER_0" ? ["firstName", "surname", "dateOfBirth", "gender"] : [],
      },
    });
  }),
);

settingsRouter.patch(
  "/profile",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        phone: z.string().optional(),
        occupation: z.string().optional(),
        employmentStatus: z.string().optional(),
        sourceOfFunds: z.string().optional(),
        dateOfBirth: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
        gender: z.string().optional(),
        biometricsLogin: z.boolean().optional(),
        biometricsTxn: z.boolean().optional(),
        firstName: z.string().min(1).optional(),
        middleName: z.string().optional().nullable(),
        surname: z.string().min(1).optional(),
      })
      .parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (user.kycTier !== "TIER_0") {
      if (body.firstName || body.surname || body.dateOfBirth || body.gender) {
        throw new AppError(400, "Identity fields are locked after verification", "PROFILE_LOCKED");
      }
    }

    const updated = await prisma.user.update({
      where: { id: req.userId! },
      data: {
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.occupation !== undefined ? { occupation: body.occupation } : {}),
        ...(body.employmentStatus !== undefined ? { employmentStatus: body.employmentStatus } : {}),
        ...(body.sourceOfFunds !== undefined ? { sourceOfFunds: body.sourceOfFunds } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.biometricsLogin !== undefined ? { biometricsLogin: body.biometricsLogin } : {}),
        ...(body.biometricsTxn !== undefined ? { biometricsTxn: body.biometricsTxn } : {}),
        ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
        ...(body.middleName !== undefined ? { middleName: body.middleName } : {}),
        ...(body.surname !== undefined ? { surname: body.surname } : {}),
        ...(body.dateOfBirth !== undefined
          ? { dateOfBirth: new Date(body.dateOfBirth) }
          : {}),
      },
    });
    res.json({ data: publicUser(updated) });
  }),
);

settingsRouter.patch(
  "/address",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        street: z.string().min(1),
        city: z.string().min(1),
        state: z.string().min(1),
        lga: z.string().min(1),
      })
      .parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: {
        addressStreet: body.street,
        addressCity: body.city,
        addressState: body.state,
        addressLga: body.lga,
        addressPending: true,
      },
    });
    res.json({
      data: {
        street: user.addressStreet,
        city: user.addressCity,
        state: user.addressState,
        lga: user.addressLga,
        pending: true,
      },
    });
  }),
);

settingsRouter.post(
  "/pin/change",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        currentPin: z.string().length(4),
        newPin: z.string().length(4),
        confirmPin: z.string().length(4),
      })
      .parse(req.body);
    if (body.newPin !== body.confirmPin) {
      throw new AppError(400, "PINs do not match", "PIN_MISMATCH");
    }
    await verifyTransactionPin(req.userId!, body.currentPin);
    await setTransactionPin(req.userId!, body.newPin);
    res.json({ data: { ok: true } });
  }),
);

settingsRouter.get(
  "/notifications",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const items = await prisma.notification.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({
      data: items.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        href: n.href,
        read: Boolean(n.readAt),
        createdAt: n.createdAt,
      })),
    });
  }),
);

settingsRouter.post(
  "/notifications/:id/read",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    await prisma.notification.updateMany({
      where: { id: String(req.params.id), userId: req.userId! },
      data: { readAt: new Date() },
    });
    res.json({ data: { ok: true } });
  }),
);

settingsRouter.get(
  "/notification-prefs",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const prefs =
      (await prisma.notificationPref.findUnique({ where: { userId: req.userId! } })) ??
      (await prisma.notificationPref.create({ data: { userId: req.userId! } }));
    res.json({ data: prefs });
  }),
);

settingsRouter.patch(
  "/notification-prefs",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        emailDeposits: z.boolean().optional(),
        emailWithdrawals: z.boolean().optional(),
        emailInvestments: z.boolean().optional(),
        emailMaturities: z.boolean().optional(),
        emailDigest: z.boolean().optional(),
        pushProducts: z.boolean().optional(),
        pushMaturities: z.boolean().optional(),
      })
      .parse(req.body);
    const prefs = await prisma.notificationPref.upsert({
      where: { userId: req.userId! },
      create: { userId: req.userId!, ...body },
      update: body,
    });
    res.json({ data: prefs });
  }),
);

settingsRouter.get(
  "/referrals",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const count = await prisma.user.count({ where: { referredBy: user.referralCode } });
    res.json({
      data: {
        code: user.referralCode,
        link: `https://www.mykipit.com/r/${user.referralCode}`,
        successfulReferrals: count,
        rewardsEarned: 0,
      },
    });
  }),
);

settingsRouter.post(
  "/help/tickets",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        category: z.string().min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
      .parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.userId!,
        category: body.category,
        subject: body.subject,
        body: body.body,
      },
    });
    res.status(201).json({ data: { id: ticket.id, status: ticket.status } });
  }),
);

settingsRouter.get(
  "/learn",
  asyncHandler(async (_req, res) => {
    const articles = await prisma.learnArticle.findMany({
      where: { published: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: articles.map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.title,
        summary: a.summary,
        category: a.category,
      })),
    });
  }),
);

settingsRouter.get(
  "/learn/:slug",
  asyncHandler(async (req, res) => {
    const a = await prisma.learnArticle.findUnique({ where: { slug: String(req.params.slug) } });
    if (!a) throw new AppError(404, "Article not found", "NOT_FOUND");
    res.json({ data: a });
  }),
);

settingsRouter.get(
  "/feed",
  asyncHandler(async (_req, res) => {
    const cards = await prisma.feedCard.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
    res.json({ data: cards });
  }),
);

settingsRouter.delete(
  "/sessions/:sessionId",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    await revokeSession(String(req.params.sessionId), req.userId!);
    res.status(204).send();
  }),
);
