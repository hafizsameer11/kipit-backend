import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AdminRoleName } from "../middleware/admin.js";

/** Permission ids — keep in sync with kipit-admin `admin-team-data` PERMISSION_GROUPS. */
export const ALL_ADMIN_PERMISSIONS = [
  "users.view",
  "users.freeze",
  "users.sessions",
  "kyc.review",
  "kyc.decide",
  "aml.investigate",
  "aml.report",
  "txn.view",
  "withdrawal.process",
  "withdrawal.decline",
  "recon.resolve",
  "adjustment.request",
  "adjustment.approve",
  "product.manage",
  "rate.propose",
  "rate.approve",
  "marketing.manage",
  "support.reply",
  "admin.manage",
  "role.manage",
  "audit.view",
] as const;

export type AdminPermission = (typeof ALL_ADMIN_PERMISSIONS)[number];

/** UI role id used in Roles & permissions / AppConfig overrides. */
export type AdminRoleKey =
  | "global-admin"
  | "operations"
  | "compliance"
  | "finance"
  | "support"
  | "read-only"
  | "marketing";

const DEFAULT_GRANTS: Record<AdminRoleKey, readonly string[]> = {
  "global-admin": ALL_ADMIN_PERMISSIONS,
  operations: [
    "users.view",
    "users.freeze",
    "txn.view",
    "withdrawal.process",
    "withdrawal.decline",
    "recon.resolve",
    "adjustment.request",
    "audit.view",
  ],
  compliance: [
    "users.view",
    "users.freeze",
    "kyc.review",
    "kyc.decide",
    "aml.investigate",
    "aml.report",
    "txn.view",
    "audit.view",
  ],
  finance: [
    "txn.view",
    "recon.resolve",
    "product.manage",
    "rate.propose",
    "rate.approve",
    "adjustment.approve",
    "audit.view",
  ],
  support: ["users.view", "users.sessions", "txn.view", "support.reply", "marketing.manage"],
  "read-only": ["users.view", "txn.view", "audit.view"],
  marketing: ["users.view", "txn.view", "marketing.manage", "audit.view"],
};

export function apiRoleToPermissionKey(role?: string | null): AdminRoleKey {
  const r = String(role || "").toUpperCase();
  if (r === "SUPER" || r === "GLOBAL") return "global-admin";
  if (r === "OPERATIONS") return "operations";
  if (r === "COMPLIANCE") return "compliance";
  if (r === "FINANCE") return "finance";
  if (r === "SUPPORT") return "support";
  if (r === "READ_ONLY") return "read-only";
  if (r === "MARKETING") return "marketing";
  return "read-only";
}

async function loadStoredOverrides(): Promise<Record<string, string[]> | null> {
  const row = await prisma.appConfig.findUnique({ where: { key: "admin.rolePermissions" } });
  if (!row?.value || typeof row.value !== "object") return null;
  return row.value as Record<string, string[]>;
}

export async function permissionsForRole(role?: string | null): Promise<string[]> {
  const key = apiRoleToPermissionKey(role);
  if (key === "global-admin") return [...ALL_ADMIN_PERMISSIONS];

  const stored = await loadStoredOverrides();
  const override = stored?.[key];
  if (Array.isArray(override)) {
    return [...new Set(override.map(String))];
  }
  return [...(DEFAULT_GRANTS[key] ?? DEFAULT_GRANTS["read-only"])];
}

export async function adminHasPermission(
  role: string | null | undefined,
  ...needed: string[]
): Promise<boolean> {
  if (!needed.length) return true;
  const grants = await permissionsForRole(role);
  if (apiRoleToPermissionKey(role) === "global-admin") return true;
  return needed.some((p) => grants.includes(p));
}

export async function assertAdminPermission(
  role: string | null | undefined,
  ...needed: string[]
): Promise<void> {
  const ok = await adminHasPermission(role, ...needed);
  if (!ok) {
    throw new AppError(403, "Insufficient permissions", "FORBIDDEN");
  }
}

/** Block all mutating work for read-only admins. */
export function assertNotReadOnly(role?: string | null) {
  if (String(role || "").toUpperCase() === "READ_ONLY") {
    throw new AppError(403, "Read-only role cannot make changes", "FORBIDDEN");
  }
}

export function isPrivilegedAdminRole(role?: string | null) {
  const r = String(role || "").toUpperCase();
  return r === "SUPER" || r === "GLOBAL";
}

export type { AdminRoleName };
