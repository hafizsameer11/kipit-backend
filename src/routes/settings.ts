import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import {
  publicUser,
  requestOtp,
  revokeSession,
  setTransactionPin,
  verifyOtp,
  verifyTransactionPin,
} from "../services/auth.js";
import { writeAudit } from "../services/audit.js";

export const settingsRouter = Router();

settingsRouter.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const lockedFields: string[] = [];
    if (user.kycTier !== "TIER_0") {
      lockedFields.push("firstName", "surname", "gender");
    }
    if (user.dateOfBirth) lockedFields.push("dateOfBirth");
    if (user.phone) lockedFields.push("phone");

    const consents = await prisma.consentAcceptance.findMany({
      where: { userId: user.id },
      orderBy: { acceptedAt: "desc" },
    });

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
        lockedFields,
        consents: consents.map((c) => ({
          docKey: c.docKey,
          version: c.version,
          acceptedAt: c.acceptedAt,
        })),
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
      if (body.firstName || body.surname || body.gender) {
        throw new AppError(400, "Identity fields are locked after verification", "PROFILE_LOCKED");
      }
    }
    if (body.dateOfBirth && user.dateOfBirth) {
      throw new AppError(400, "Date of birth is already set. Contact support to change it.", "PROFILE_LOCKED");
    }
    if (body.phone && user.phone) {
      throw new AppError(400, "Phone is already set. Contact support to change it.", "PROFILE_LOCKED");
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

function parseDobInput(raw: string): Date | null {
  const trimmed = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed
    : (() => {
        const m = trimmed.match(/^(\d{1,2})\s*[\/\-]\s*(\d{1,2})\s*[\/\-]\s*(\d{4})$/);
        if (!m) return null;
        const day = m[1]!.padStart(2, "0");
        const month = m[2]!.padStart(2, "0");
        return `${m[3]}-${month}-${day}`;
      })();
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

settingsRouter.post(
  "/pin/reset/request",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ dateOfBirth: z.string().min(4) }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!user.email) {
      throw new AppError(400, "Add an email to your account before resetting your PIN", "EMAIL_REQUIRED");
    }
    const inputDob = parseDobInput(body.dateOfBirth);
    if (!inputDob || !user.dateOfBirth) {
      throw new AppError(400, "Date of birth does not match our records", "DOB_MISMATCH");
    }
    const stored = user.dateOfBirth.toISOString().slice(0, 10);
    const given = inputDob.toISOString().slice(0, 10);
    if (stored !== given) {
      throw new AppError(400, "Date of birth does not match our records", "DOB_MISMATCH");
    }

    const otp = await requestOtp({
      target: user.email,
      purpose: "PIN_RESET",
      userId: user.id,
    });

    const at = user.email.indexOf("@");
    const hint =
      at > 1
        ? `${user.email[0]}${"•".repeat(Math.min(at - 1, 4))}${user.email.slice(at)}`
        : user.email;

    res.json({
      data: {
        sent: true,
        targetHint: hint,
        expiresAt: otp.expiresAt,
        ...(otp.debugCode ? { debugCode: otp.debugCode } : {}),
      },
    });
  }),
);

settingsRouter.post(
  "/pin/reset",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        code: z.string().min(4).max(8),
        newPin: z.string().length(4),
        confirmPin: z.string().length(4),
      })
      .parse(req.body);
    if (body.newPin !== body.confirmPin) {
      throw new AppError(400, "PINs do not match", "PIN_MISMATCH");
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!user.email) {
      throw new AppError(400, "Add an email to your account before resetting your PIN", "EMAIL_REQUIRED");
    }
    await verifyOtp({
      target: user.email,
      purpose: "PIN_RESET",
      code: body.code,
    });
    await setTransactionPin(user.id, body.newPin);
    await writeAudit({
      actorUserId: user.id,
      action: "user.pin_reset",
      entityType: "User",
      entityId: user.id,
    });
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
    const referred = await prisma.user.findMany({
      where: { referredBy: user.referralCode },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstName: true,
        surname: true,
        createdAt: true,
        kycTier: true,
      },
    });

    const people = await Promise.all(
      referred.map(async (r) => {
        const funded =
          (await prisma.placement.count({ where: { userId: r.id }, take: 1 })) > 0 ||
          (await prisma.ledgerAccount.count({
            where: { userId: r.id, balanceKobo: { gt: 0 } },
            take: 1,
          })) > 0 ||
          (await prisma.journalLine.count({
            where: { account: { userId: r.id } },
            take: 1,
          })) > 0;
        return {
          id: r.id,
          name: `${r.firstName} ${r.surname}`.trim(),
          joined: r.createdAt.toISOString(),
          status: funded ? ("rewarded" as const) : ("pending" as const),
          note: funded ? "Funded account" : r.kycTier === "TIER_0" ? "Signed up" : "Verified",
          reward: funded ? 500 : 0,
        };
      }),
    );

    const rewardsEarned = people.reduce((sum, p) => sum + p.reward, 0);

    res.json({
      data: {
        code: user.referralCode,
        link: `https://www.mykipit.com/r/${user.referralCode}`,
        successfulReferrals: people.filter((p) => p.status === "rewarded").length,
        totalReferrals: people.length,
        rewardsEarned,
        people,
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
        category: z.string().min(1).max(80),
        subject: z.string().min(1).max(160),
        body: z.string().min(1).max(4000),
      })
      .parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.userId!,
        category: body.category,
        subject: body.subject,
        body: body.body,
        messages: {
          create: {
            author: "USER",
            body: body.body,
          },
        },
      },
    });
    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: "Support ticket received",
        body: `We've logged “${ticket.subject}”. Our team typically replies within one business day.`,
        href: `/settings/help/tickets/${ticket.id}`,
      },
    });
    res.status(201).json({
      data: {
        id: ticket.id,
        status: ticket.status,
        category: ticket.category,
        subject: ticket.subject,
        createdAt: ticket.createdAt,
      },
    });
  }),
);

settingsRouter.get(
  "/help/tickets",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const rows = await prisma.supportTicket.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
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
      })),
    });
  }),
);

settingsRouter.get(
  "/help/tickets/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: String(req.params.id), userId: req.userId! },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!ticket) throw new AppError(404, "Ticket not found", "NOT_FOUND");

    const messages =
      ticket.messages.length > 0
        ? ticket.messages
        : [
            {
              id: `legacy-${ticket.id}`,
              author: "USER",
              body: ticket.body,
              createdAt: ticket.createdAt,
            },
          ];

    res.json({
      data: {
        id: ticket.id,
        category: ticket.category,
        subject: ticket.subject,
        body: ticket.body,
        status: ticket.status,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messages: messages.map((m) => ({
          id: m.id,
          author: m.author,
          body: m.body,
          createdAt: m.createdAt,
        })),
      },
    });
  }),
);

settingsRouter.post(
  "/help/tickets/:id/messages",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: String(req.params.id), userId: req.userId! },
    });
    if (!ticket) throw new AppError(404, "Ticket not found", "NOT_FOUND");
    if (ticket.status === "CLOSED" || ticket.status === "RESOLVED") {
      throw new AppError(400, "This ticket is closed. Submit a new one if you need more help.", "TICKET_CLOSED");
    }

    // Ensure legacy tickets have an opening message before replies.
    const existingCount = await prisma.supportTicketMessage.count({ where: { ticketId: ticket.id } });
    if (existingCount === 0) {
      await prisma.supportTicketMessage.create({
        data: { ticketId: ticket.id, author: "USER", body: ticket.body, createdAt: ticket.createdAt },
      });
    }

    const message = await prisma.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        author: "USER",
        body: body.body.trim(),
      },
    });
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: ticket.status === "OPEN" ? "OPEN" : "IN_PROGRESS", updatedAt: new Date() },
    });

    res.status(201).json({
      data: {
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt: message.createdAt,
      },
    });
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
