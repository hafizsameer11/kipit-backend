import { getConfigJson } from "./admin-ops-store.js";

type SettingRow = { id: string; label: string; value: string; note: string };

const DEFAULT_FEES: SettingRow[] = [
  { id: "f-withdraw", label: "Withdrawal fee", value: "50", note: "Flat ₦ per payout" },
  { id: "f-card", label: "Card funding fee", value: "1.4", note: "% of amount, capped ₦2,000" },
  { id: "f-early", label: "Early liquidation penalty", value: "25", note: "% of accrued interest" },
  { id: "f-transfer", label: "Wallet transfer fee", value: "0", note: "Flat ₦ per transfer" },
];

const DEFAULT_LIMITS: SettingRow[] = [
  { id: "l-t1-day", label: "Tier 1 daily withdrawal", value: "200000", note: "₦ per day" },
  { id: "l-t2-day", label: "Tier 2 daily withdrawal", value: "5000000", note: "₦ per day" },
  { id: "l-single", label: "Single payout maximum", value: "10000000", note: "₦, above needs maker-checker" },
  { id: "l-min-fixed", label: "Minimum fixed placement", value: "100000", note: "₦ per plan" },
  { id: "l-min-call", label: "Minimum call deposit", value: "10000", note: "₦ per deposit" },
];

const DEFAULT_CUTOFFS: SettingRow[] = [
  { id: "c-payout", label: "Withdrawal batch cut-off", value: "15:30", note: "Requests after this settle next day" },
  { id: "c-value", label: "Value date cut-off", value: "17:00", note: "Interest starts same day before this" },
  { id: "c-recon", label: "Reconciliation run", value: "07:00", note: "Daily automated match" },
  { id: "c-interest", label: "Interest accrual run", value: "00:15", note: "Nightly job" },
];

/** Merge stored rows onto the canonical catalogue so blank/partial stores don't wipe defaults. */
export function mergeSettingRows(
  defaults: SettingRow[],
  stored: SettingRow[] | undefined | null,
): SettingRow[] {
  const byId = new Map(defaults.map((d) => [d.id, { ...d }]));
  for (const row of stored ?? []) {
    if (!row?.id || !byId.has(row.id)) continue;
    const base = byId.get(row.id)!;
    const value = String(row.value ?? "").trim();
    byId.set(row.id, {
      ...base,
      label: String(row.label || base.label),
      note: String(row.note || base.note),
      value: value !== "" ? value : base.value,
    });
  }
  return defaults.map((d) => byId.get(d.id)!);
}

function rowNumber(rows: SettingRow[], id: string, fallback: number): number {
  const row = rows.find((r) => r.id === id);
  const n = Number(String(row?.value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function rowTime(rows: SettingRow[], id: string, fallback: string): string {
  const raw = String(rows.find((r) => r.id === id)?.value ?? fallback).trim();
  if (!/^\d{1,2}:\d{2}$/.test(raw)) return fallback;
  const [h, m] = raw.split(":");
  return `${String(h).padStart(2, "0")}:${m}`;
}

export type OpsLimits = {
  tier1DailyWithdrawal: number;
  tier2DailyWithdrawal: number;
  singlePayoutMax: number;
  minFixedPlacement: number;
  minCallDeposit: number;
  withdrawalFee: number;
  cardFundingPct: number;
};

export type OpsCutoffs = {
  /** HH:MM Lagos — withdrawals after this settle next day. */
  payoutBatch: string;
  /** HH:MM Lagos — interest starts same day only if funded before this. */
  valueDate: string;
  /** HH:MM Lagos — daily recon job. */
  reconRun: string;
  /** HH:MM Lagos — maturity + call interest job. */
  interestAccrual: string;
};

export async function resolveSystemSettingRows() {
  const settings = await getConfigJson<{
    fees?: SettingRow[];
    limits?: SettingRow[];
    cutoffs?: SettingRow[];
  }>("system.settings", {});
  return {
    fees: mergeSettingRows(DEFAULT_FEES, settings.fees),
    limits: mergeSettingRows(DEFAULT_LIMITS, settings.limits),
    cutoffs: mergeSettingRows(DEFAULT_CUTOFFS, settings.cutoffs),
  };
}

export async function getOpsLimits(): Promise<OpsLimits> {
  const { fees, limits } = await resolveSystemSettingRows();
  return {
    tier1DailyWithdrawal: rowNumber(limits, "l-t1-day", 200_000),
    tier2DailyWithdrawal: rowNumber(limits, "l-t2-day", 5_000_000),
    singlePayoutMax: rowNumber(limits, "l-single", 10_000_000),
    minFixedPlacement: rowNumber(limits, "l-min-fixed", 100_000),
    minCallDeposit: rowNumber(limits, "l-min-call", 10_000),
    withdrawalFee: rowNumber(fees, "f-withdraw", 50),
    cardFundingPct: rowNumber(fees, "f-card", 1.4),
  };
}

export async function getOpsCutoffs(): Promise<OpsCutoffs> {
  const { cutoffs } = await resolveSystemSettingRows();
  return {
    payoutBatch: rowTime(cutoffs, "c-payout", "15:30"),
    valueDate: rowTime(cutoffs, "c-value", "17:00"),
    reconRun: rowTime(cutoffs, "c-recon", "07:00"),
    interestAccrual: rowTime(cutoffs, "c-interest", "00:15"),
  };
}

/** Current HH:MM in Africa/Lagos. */
export function currentLagosHm(now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
  } catch {
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
}

export function lagosDateKey(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isAtOrAfterHm(nowHm: string, cutoffHm: string): boolean {
  return hmToMinutes(nowHm) >= hmToMinutes(cutoffHm);
}

/** Next calendar day (YYYY-MM-DD) after a Lagos date key. */
export function nextLagosDateKey(dateKey: string): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, mo! - 1, d! + 1));
  return utc.toISOString().slice(0, 10);
}

/** Instant for YYYY-MM-DD 00:00 Africa/Lagos (WAT, UTC+1). */
export function lagosDayStartUtc(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+01:00`);
}

export function lagosHmOnDateUtc(dateKey: string, hm: string): Date {
  const [h, m] = hm.split(":");
  return new Date(`${dateKey}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+01:00`);
}

/**
 * Withdrawal settlement date (Lagos calendar).
 * Before payout cut-off → same day; at/after → next day.
 */
export function settleOnFromCutoff(
  createdAt: Date,
  payoutBatchHm: string,
): { settleOn: string; sameDay: boolean; cutoff: string } {
  const day = lagosDateKey(createdAt);
  const sameDay = !isAtOrAfterHm(currentLagosHm(createdAt), payoutBatchHm);
  return {
    settleOn: sameDay ? day : nextLagosDateKey(day),
    sameDay,
    cutoff: payoutBatchHm,
  };
}

export async function withdrawalSettleOn(at = new Date()): Promise<{
  settleOn: string;
  sameDay: boolean;
  cutoff: string;
}> {
  const { payoutBatch } = await getOpsCutoffs();
  return settleOnFromCutoff(at, payoutBatch);
}

/**
 * Interest value date (Lagos calendar) for a funding event.
 * Before value cut-off → same day; at/after → next day.
 */
export async function interestValueDate(at = new Date()): Promise<{
  valueDate: string;
  sameDay: boolean;
  cutoff: string;
}> {
  const { valueDate: cutoff } = await getOpsCutoffs();
  const today = lagosDateKey(at);
  const sameDay = !isAtOrAfterHm(currentLagosHm(at), cutoff);
  return {
    valueDate: sameDay ? today : nextLagosDateKey(today),
    sameDay,
    cutoff,
  };
}

export { DEFAULT_FEES, DEFAULT_LIMITS, DEFAULT_CUTOFFS };
