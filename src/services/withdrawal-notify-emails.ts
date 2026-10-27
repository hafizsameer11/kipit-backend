import { randomUUID } from "crypto";
import { AppError } from "../lib/errors.js";
import { getConfigJson, setConfigJson } from "./admin-ops-store.js";

const EMAILS_KEY = "ops.withdrawalNotifyEmails";
const ACTIVITY_KEY = "ops.withdrawalNotifyActivity";
const ACTIVITY_CAP = 250;

export type WithdrawalNotifyEmail = {
  id: string;
  email: string;
  label: string;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
};

export type WithdrawalNotifyActivity = {
  id: string;
  email: string;
  status: "sent" | "failed";
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  withdrawalId: string | null;
  reference: string | null;
  amountNaira: number | null;
  subject: string;
  at: string;
};

function normalizeEmail(raw: string) {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function listWithdrawalNotifyEmails(): Promise<WithdrawalNotifyEmail[]> {
  const rows = await getConfigJson<WithdrawalNotifyEmail[]>(EMAILS_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export async function listActiveWithdrawalNotifyEmails(): Promise<WithdrawalNotifyEmail[]> {
  return (await listWithdrawalNotifyEmails()).filter((r) => r.active && r.email);
}

export async function addWithdrawalNotifyEmail(input: {
  email: string;
  label?: string;
  adminId?: string | null;
}): Promise<WithdrawalNotifyEmail> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    throw new AppError(400, "Enter a valid email address", "INVALID_EMAIL");
  }
  const rows = await listWithdrawalNotifyEmails();
  if (rows.some((r) => r.email === email)) {
    throw new AppError(409, "That email is already on the list", "EMAIL_EXISTS");
  }
  const row: WithdrawalNotifyEmail = {
    id: randomUUID(),
    email,
    label: (input.label || "").trim().slice(0, 80),
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: input.adminId ?? null,
  };
  await setConfigJson(EMAILS_KEY, [row, ...rows], input.adminId ?? undefined);
  return row;
}

export async function updateWithdrawalNotifyEmail(
  id: string,
  patch: { active?: boolean; label?: string },
  adminId?: string | null,
): Promise<WithdrawalNotifyEmail> {
  const rows = await listWithdrawalNotifyEmails();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) throw new AppError(404, "Email not found", "NOT_FOUND");
  const current = rows[idx]!;
  const next: WithdrawalNotifyEmail = {
    ...current,
    active: typeof patch.active === "boolean" ? patch.active : current.active,
    label:
      typeof patch.label === "string" ? patch.label.trim().slice(0, 80) : current.label,
  };
  const copy = [...rows];
  copy[idx] = next;
  await setConfigJson(EMAILS_KEY, copy, adminId ?? undefined);
  return next;
}

export async function removeWithdrawalNotifyEmail(
  id: string,
  adminId?: string | null,
): Promise<void> {
  const rows = await listWithdrawalNotifyEmails();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) {
    throw new AppError(404, "Email not found", "NOT_FOUND");
  }
  await setConfigJson(EMAILS_KEY, next, adminId ?? undefined);
}

export async function listWithdrawalNotifyActivity(limit = 100): Promise<WithdrawalNotifyActivity[]> {
  const rows = await getConfigJson<WithdrawalNotifyActivity[]>(ACTIVITY_KEY, []);
  const list = Array.isArray(rows) ? rows : [];
  return list.slice(0, Math.min(Math.max(limit, 1), ACTIVITY_CAP));
}

export async function recordWithdrawalNotifyActivity(
  entries: Omit<WithdrawalNotifyActivity, "id" | "at">[],
) {
  if (!entries.length) return;
  const existing = await getConfigJson<WithdrawalNotifyActivity[]>(ACTIVITY_KEY, []);
  const prev = Array.isArray(existing) ? existing : [];
  const now = new Date().toISOString();
  const added: WithdrawalNotifyActivity[] = entries.map((e) => ({
    id: randomUUID(),
    at: now,
    ...e,
  }));
  await setConfigJson(ACTIVITY_KEY, [...added, ...prev].slice(0, ACTIVITY_CAP));
}
