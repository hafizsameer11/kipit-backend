import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const SIGNUP_STEPS = [
  "method",
  "email",
  "otp",
  "details",
  "password",
  "pin",
  "biometrics",
  "complete",
] as const;

export type SignupStep = (typeof SIGNUP_STEPS)[number];

export async function logSignupStep(input: {
  step: string;
  email?: string | null;
  phone?: string | null;
  deviceId?: string | null;
  completed?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const email = input.email?.toLowerCase().trim() || null;
  const phone = input.phone?.trim() || null;
  const deviceId = input.deviceId?.trim() || null;
  if (!email && !phone && !deviceId) {
    return null;
  }
  return prisma.signupFunnelEvent.create({
    data: {
      step: input.step,
      email,
      phone,
      deviceId,
      completed: input.completed ?? input.step === "complete",
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Latest incomplete funnel row per email/device for drop-off queue. */
export async function listSignupDropoffs(limit = 100) {
  const [incomplete, completed] = await Promise.all([
    prisma.signupFunnelEvent.findMany({
      where: { completed: false },
      orderBy: { createdAt: "desc" },
      take: 800,
    }),
    prisma.signupFunnelEvent.findMany({
      where: { completed: true },
      select: { email: true, phone: true, deviceId: true },
      take: 2000,
    }),
  ]);

  const doneEmails = new Set(completed.map((r) => r.email?.toLowerCase()).filter(Boolean) as string[]);
  const donePhones = new Set(completed.map((r) => r.phone).filter(Boolean) as string[]);
  const doneDevices = new Set(completed.map((r) => r.deviceId).filter(Boolean) as string[]);

  const latest = new Map<
    string,
    {
      id: string;
      email: string | null;
      phone: string | null;
      deviceId: string | null;
      step: string;
      lastSeenAt: string;
      metadata: unknown;
    }
  >();

  for (const row of incomplete) {
    if (row.email && doneEmails.has(row.email.toLowerCase())) continue;
    if (row.phone && donePhones.has(row.phone)) continue;
    if (row.deviceId && doneDevices.has(row.deviceId)) continue;
    const key = (row.email || row.phone || row.deviceId || row.id).toLowerCase();
    if (latest.has(key)) continue;
    latest.set(key, {
      id: row.id,
      email: row.email,
      phone: row.phone,
      deviceId: row.deviceId,
      step: row.step,
      lastSeenAt: row.createdAt.toISOString(),
      metadata: row.metadata,
    });
    if (latest.size >= limit) break;
  }

  return Array.from(latest.values());
}
