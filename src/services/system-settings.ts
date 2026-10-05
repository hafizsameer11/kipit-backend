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

export type OpsLimits = {
  tier1DailyWithdrawal: number;
  tier2DailyWithdrawal: number;
  singlePayoutMax: number;
  minFixedPlacement: number;
  minCallDeposit: number;
  withdrawalFee: number;
  cardFundingPct: number;
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

export { DEFAULT_FEES, DEFAULT_LIMITS, DEFAULT_CUTOFFS };
