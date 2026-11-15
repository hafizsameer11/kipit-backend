/**
 * Kipit Lock / Kipit Flex rate catalogue (B8, C10, Appendix D).
 * Rates are **net** (after 10% WHT). Scale: percent × 10_000.
 */
import type { InterestPayout, RateFamily, RateBand } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { rateStoredFromPct } from "./money.js";
import { formatRatePair, grossRatePctFromNet, interestBreakdownFromNetRate } from "./wht.js";

export const PLAN_MIN_NAIRA = 1_000;
export const LOCK_STANDARD_TENORS = [30, 60, 90, 180, 365] as const;
export const FLEX_STANDARD_TENORS = [60, 90, 180, 365] as const;
export const CUSTOM_MIN_DAYS = 31;
export const CUSTOM_MAX_DAYS = 365;
export const FLEX_BREAK_MIN_DAYS = 30;

/** Appendix D defaults (November 2026) — net rates. */
export const APPENDIX_D_LOCK_MATURITY: Record<number, number> = {
  30: 10.0,
  60: 13.0,
  90: 16.0,
  180: 19.0,
  365: 22.0,
};

export const APPENDIX_D_LOCK_UPFRONT: Record<number, number> = {
  30: 9.92,
  60: 12.73,
  90: 15.39,
  180: 17.37,
  365: 18.03,
};

export const APPENDIX_D_FLEX: Record<number, number> = {
  60: 9.0,
  90: 12.0,
  180: 15.0,
  365: 18.0,
};

export const APPENDIX_D_CALL_NET = 8.0;

export function lockFlexBandCode(
  family: "LOCK" | "FLEX",
  tenorDays: number,
  payout: InterestPayout = "AT_MATURITY",
) {
  if (family === "FLEX") return `FLEX_${tenorDays}`;
  return payout === "UPFRONT" ? `LOCK_UP_${tenorDays}` : `LOCK_${tenorDays}`;
}

export function displayPlanName(planType: "LOCK" | "FLEX" | null | undefined, tenorDays: number | null | undefined) {
  const days = tenorDays && tenorDays > 0 ? tenorDays : null;
  const type = planType === "FLEX" ? "Kipit Flex" : "Kipit Lock";
  return days ? `${type}, ${days} days` : type;
}

/** Nearest standard tenor at or below `days` (custom default rule). */
export function nearestStandardAtOrBelow(days: number, standards: readonly number[]) {
  const sorted = [...standards].sort((a, b) => b - a);
  for (const t of sorted) {
    if (days >= t) return t;
  }
  return standards[0]!;
}

/**
 * Upfront net rate from at-maturity net rate (C10 formula).
 * Upfront = AtMaturity / (1 + AtMaturity × Days / 365)
 */
export function upfrontNetPctFromAtMaturity(atMaturityNetPct: number, days: number) {
  const r = atMaturityNetPct / 100;
  const upfront = r / (1 + (r * days) / 365);
  return upfront * 100;
}

export type LockFlexRateView = {
  code: string;
  family: RateFamily;
  payout: InterestPayout | null;
  standardTenorDays: number | null;
  minDays: number;
  maxDays: number | null;
  rateBps: number;
  ratePct: number;
  grossRatePct: number;
  rateLabel: string;
  minimum: number;
  label: string;
};

function toView(b: RateBand): LockFlexRateView {
  const pair = formatRatePair(b.rateBps);
  return {
    code: b.code,
    family: b.family ?? "CALL",
    payout: b.payout,
    standardTenorDays: b.standardTenorDays,
    minDays: b.minDays,
    maxDays: b.maxDays,
    rateBps: b.rateBps,
    ratePct: pair.netRatePct,
    grossRatePct: pair.grossRatePct,
    rateLabel: pair.label,
    minimum: PLAN_MIN_NAIRA,
    label: b.label,
  };
}

/** Seed / upsert Appendix D Lock, Flex, Call bands. Leaves legacy codes untouched. */
export async function ensureLockFlexRateBands() {
  const rows: {
    code: string;
    label: string;
    minDays: number;
    maxDays: number | null;
    rateBps: number;
    family: RateFamily;
    payout: InterestPayout | null;
    standardTenorDays: number | null;
  }[] = [
    {
      code: "CALL",
      label: "Call Account",
      minDays: 0,
      maxDays: 0,
      rateBps: rateStoredFromPct(APPENDIX_D_CALL_NET),
      family: "CALL",
      payout: null,
      standardTenorDays: null,
    },
  ];

  for (const days of LOCK_STANDARD_TENORS) {
    rows.push({
      code: lockFlexBandCode("LOCK", days, "AT_MATURITY"),
      label: `Kipit Lock ${days} days (at maturity)`,
      minDays: days,
      maxDays: days,
      rateBps: rateStoredFromPct(APPENDIX_D_LOCK_MATURITY[days]!),
      family: "LOCK",
      payout: "AT_MATURITY",
      standardTenorDays: days,
    });
    rows.push({
      code: lockFlexBandCode("LOCK", days, "UPFRONT"),
      label: `Kipit Lock ${days} days (upfront)`,
      minDays: days,
      maxDays: days,
      rateBps: rateStoredFromPct(APPENDIX_D_LOCK_UPFRONT[days]!),
      family: "LOCK",
      payout: "UPFRONT",
      standardTenorDays: days,
    });
  }

  for (const days of FLEX_STANDARD_TENORS) {
    rows.push({
      code: lockFlexBandCode("FLEX", days, "AT_MATURITY"),
      label: `Kipit Flex ${days} days`,
      minDays: days,
      maxDays: days,
      rateBps: rateStoredFromPct(APPENDIX_D_FLEX[days]!),
      family: "FLEX",
      payout: "AT_MATURITY",
      standardTenorDays: days,
    });
  }

  for (const b of rows) {
    // Create-only for rateBps — approved rate changes must stick (C10).
    // Metadata (label/family/payout/tenor) can refresh without resetting live rates.
    await prisma.rateBand.upsert({
      where: { code: b.code },
      create: b,
      update: {
        label: b.label,
        minDays: b.minDays,
        maxDays: b.maxDays,
        family: b.family,
        payout: b.payout,
        standardTenorDays: b.standardTenorDays,
      },
    });
  }
}

export async function listLockFlexRates() {
  await ensureLockFlexRateBands();
  const { ensureRatesApplied } = await import("./rates.js");
  await ensureRatesApplied();
  const bands = await prisma.rateBand.findMany({
    where: { family: { in: ["CALL", "LOCK", "FLEX"] } },
    orderBy: [{ family: "asc" }, { standardTenorDays: "asc" }, { payout: "asc" }],
  });
  return bands.map(toView);
}

export async function resolvePlanRate(input: {
  planType: "LOCK" | "FLEX";
  tenorDays: number;
  interestPayout?: InterestPayout;
}) {
  await ensureLockFlexRateBands();
  const { ensureRatesApplied } = await import("./rates.js");
  await ensureRatesApplied();

  const payout: InterestPayout =
    input.planType === "FLEX" ? "AT_MATURITY" : (input.interestPayout ?? "AT_MATURITY");

  if (input.planType === "FLEX" && input.tenorDays <= 30) {
    throw new AppError(400, "Kipit Flex requires more than 30 days", "INVALID_TENOR");
  }
  if (input.tenorDays < 1 || input.tenorDays > CUSTOM_MAX_DAYS) {
    throw new AppError(400, "Tenor must be between 1 and 365 days", "INVALID_TENOR");
  }
  if (
    input.planType === "LOCK" &&
    input.tenorDays !== 30 &&
    (input.tenorDays < CUSTOM_MIN_DAYS || input.tenorDays > CUSTOM_MAX_DAYS) &&
    !(LOCK_STANDARD_TENORS as readonly number[]).includes(input.tenorDays)
  ) {
    // custom allowed 31-365; 30 is standard
  }

  const standards =
    input.planType === "LOCK" ? LOCK_STANDARD_TENORS : FLEX_STANDARD_TENORS;
  const isStandard = (standards as readonly number[]).includes(input.tenorDays);

  if (isStandard) {
    const code = lockFlexBandCode(input.planType, input.tenorDays, payout);
    const band = await prisma.rateBand.findUnique({ where: { code } });
    if (!band) throw new AppError(400, "Rate band missing", "RATE_BAND_MISSING");
    return { band, rateBps: band.rateBps, matchedTenor: input.tenorDays };
  }

  // Custom: nearest standard at or below; Flex 31–59 → 60-day rate
  let matchDays: number;
  if (input.planType === "FLEX" && input.tenorDays >= 31 && input.tenorDays <= 59) {
    matchDays = 60;
  } else {
    matchDays = nearestStandardAtOrBelow(input.tenorDays, standards);
  }

  if (payout === "UPFRONT" && input.planType === "LOCK") {
    const matBand = await prisma.rateBand.findUnique({
      where: { code: lockFlexBandCode("LOCK", matchDays, "AT_MATURITY") },
    });
    if (!matBand) throw new AppError(400, "Rate band missing", "RATE_BAND_MISSING");
    const atMatPct = matBand.rateBps / 10_000;
    const upfrontPct = upfrontNetPctFromAtMaturity(atMatPct, input.tenorDays);
    // Prefer stored upfront band for matched tenor if custom days === standard
    const upBand = await prisma.rateBand.findUnique({
      where: { code: lockFlexBandCode("LOCK", matchDays, "UPFRONT") },
    });
    return {
      band: upBand ?? matBand,
      rateBps: rateStoredFromPct(upfrontPct),
      matchedTenor: matchDays,
    };
  }

  const code = lockFlexBandCode(input.planType, matchDays, "AT_MATURITY");
  const band = await prisma.rateBand.findUnique({ where: { code } });
  if (!band) throw new AppError(400, "Rate band missing", "RATE_BAND_MISSING");
  return { band, rateBps: band.rateBps, matchedTenor: matchDays };
}

export function previewPlanInterest(principalKobo: bigint, netRateBps: number, days: number) {
  const b = interestBreakdownFromNetRate(principalKobo, netRateBps, days);
  return {
    ...b,
    grossRatePct: grossRatePctFromNet(b.netRatePct),
    valueAtMaturityKobo: principalKobo + b.netKobo,
  };
}
