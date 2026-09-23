import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function getConfigJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appConfig.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value as T;
}

export async function setConfigJson(
  key: string,
  value: unknown,
  updatedBy?: string,
) {
  await prisma.appConfig.upsert({
    where: { key },
    create: {
      key,
      value: value as Prisma.InputJsonValue,
      updatedBy,
    },
    update: {
      value: value as Prisma.InputJsonValue,
      updatedBy,
    },
  });
}

export type StoredCampaign = {
  id: string;
  name: string;
  channel: string;
  status: "draft" | "scheduled" | "sending" | "sent" | "paused";
  audience: string;
  subject: string;
  body: string;
  scheduledAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredAmlAlert = {
  id: string;
  userId?: string | null;
  customerName: string;
  email?: string | null;
  rule: string;
  severity: "low" | "medium" | "high";
  status: "open" | "cleared" | "escalated" | "str_filed";
  amount?: number;
  notes: { at: string; author: string; body: string }[];
  assignee?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredReconRecord = {
  id: string;
  reference: string;
  customerName: string;
  source: string;
  variance: number;
  status: "open" | "investigating" | "resolved";
  notes: { at: string; author: string; body: string }[];
  createdAt: string;
  updatedAt: string;
};

export type StoredAdjustment = {
  id: string;
  placementId: string;
  customerName: string;
  product: string;
  type: "principal" | "rate" | "tenor" | "maturity";
  fromValue: string;
  toValue: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  maker: string;
  createdAt: string;
  decidedAt?: string | null;
  decisionNote?: string | null;
};
