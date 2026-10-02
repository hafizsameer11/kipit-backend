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

export async function readMaintenanceState() {
  const settings = await getConfigJson("system.settings", { maintenance: DEFAULT_MAINTENANCE });
  const maintenance = {
    ...DEFAULT_MAINTENANCE,
    ...(settings as { maintenance?: { enabled?: boolean; message?: string } }).maintenance,
  };
  return {
    enabled: Boolean(maintenance.enabled),
    message: String(maintenance.message || DEFAULT_MAINTENANCE.message),
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
