/**
 * Public app config helpers (maintenance + feature flags).
 * Kept separate from admin-console routes to avoid heavy imports in customer paths.
 */
import { AppError } from "../lib/errors.js";
import { getConfigJson } from "./admin-ops-store.js";

const DEFAULT_FLAGS = [
  { id: "ff-ai", enabled: true },
  { id: "ff-auto", enabled: true },
  { id: "ff-gift", enabled: true },
  { id: "ff-explore", enabled: true },
] as const;

const DEFAULT_MAINTENANCE = {
  enabled: false,
  message: "Kipit is under maintenance. Please try again shortly.",
  windowStart: null as string | null,
  windowEnd: null as string | null,
};

export type PublicFeatureFlags = {
  askAi: boolean;
  autoInvest: boolean;
  giftInvest: boolean;
  explore: boolean;
};

export async function readPublicFeatureFlags(): Promise<PublicFeatureFlags> {
  const settings = await getConfigJson("system.settings", {
    flags: [...DEFAULT_FLAGS],
    maintenance: DEFAULT_MAINTENANCE,
  });
  const storedFlags =
    (settings as { flags?: { id: string; enabled?: boolean }[] }).flags ?? [];
  const byId = new Map(storedFlags.map((f) => [f.id, f]));
  const flagOn = (id: string) => {
    const hit = byId.get(id);
    if (hit && typeof hit.enabled === "boolean") return hit.enabled;
    return DEFAULT_FLAGS.find((f) => f.id === id)?.enabled ?? true;
  };
  return {
    askAi: flagOn("ff-ai"),
    autoInvest: flagOn("ff-auto"),
    giftInvest: flagOn("ff-gift"),
    explore: flagOn("ff-explore"),
  };
}

type StoredMaintenance = {
  enabled?: boolean;
  message?: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  /** Legacy free-text window — ignored for scheduling. */
  window?: string | null;
};

function inScheduledWindow(m: StoredMaintenance, now = Date.now()): boolean {
  const startRaw = m.windowStart?.trim();
  const endRaw = m.windowEnd?.trim();
  if (!startRaw || !endRaw) return false;
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  return now >= start && now <= end;
}

export async function readMaintenanceState() {
  const settings = await getConfigJson("system.settings", { maintenance: DEFAULT_MAINTENANCE });
  const maintenance: StoredMaintenance = {
    ...DEFAULT_MAINTENANCE,
    ...(settings as { maintenance?: StoredMaintenance }).maintenance,
  };
  const scheduledOn = inScheduledWindow(maintenance);
  return {
    enabled: Boolean(maintenance.enabled) || scheduledOn,
    message: String(maintenance.message || DEFAULT_MAINTENANCE.message),
    windowStart: maintenance.windowStart ?? null,
    windowEnd: maintenance.windowEnd ?? null,
    scheduledActive: scheduledOn,
  };
}

export async function assertNotInMaintenance() {
  const maintenance = await readMaintenanceState();
  if (maintenance.enabled) {
    throw new AppError(503, maintenance.message, "MAINTENANCE");
  }
}

export async function assertFeatureEnabled(
  flag: keyof PublicFeatureFlags,
  message = "This feature is temporarily unavailable.",
) {
  const flags = await readPublicFeatureFlags();
  if (!flags[flag]) {
    throw new AppError(403, message, "FEATURE_DISABLED");
  }
}
