/**
 * Withholding tax (B28): 10% of gross interest.
 * Admin/client rates are stored as **net** (what the client earns after WHT).
 * Gross rate = net / (1 - WHT) = net / 0.9.
 *
 * Stored rate scale matches money.ts: percent × 10_000 (4 d.p.).
 */

export const WHT_FRACTION = 0.1;
export const NET_FROM_GROSS = 1 - WHT_FRACTION; // 0.9

import { interestForPeriod, RATE_PCT_SCALE, ratePctFromStored, rateStoredFromPct } from "./money.js";

export function grossRatePctFromNet(netPct: number, whtRatePct = WHT_FRACTION * 100) {
  const netFraction = 1 - whtRatePct / 100;
  if (netFraction <= 0) return netPct;
  return netPct / netFraction;
}

export function netRatePctFromGross(grossPct: number, whtRatePct = WHT_FRACTION * 100) {
  return grossPct * (1 - whtRatePct / 100);
}

export function netRateStoredFromGrossPct(grossPct: number, whtRatePct = WHT_FRACTION * 100) {
  return rateStoredFromPct(netRatePctFromGross(grossPct, whtRatePct));
}

export function grossRateStoredFromNet(netStored: number) {
  return rateStoredFromPct(grossRatePctFromNet(ratePctFromStored(netStored)));
}

export function netRateStoredFromGross(grossStored: number) {
  return rateStoredFromPct(netRatePctFromGross(ratePctFromStored(grossStored)));
}

export type InterestBreakdownKobo = {
  /** Gross interest before WHT */
  grossKobo: bigint;
  /** 10% of gross */
  whtKobo: bigint;
  /** Net interest after WHT (what client receives) */
  netKobo: bigint;
  netRatePct: number;
  grossRatePct: number;
  whtRatePct: number;
};

/**
 * Interest for a period using **net** stored rate.
 * Net interest = P × netRate × days / 365.
 * Gross = net / 0.9; WHT = gross − net.
 */
function grossKoboFromNet(netKobo: bigint, whtRatePct: number) {
  if (whtRatePct <= 0) return netKobo;
  const netBp = Math.round((100 - whtRatePct) * 100);
  if (netBp <= 0) return netKobo;
  return (netKobo * 10000n) / BigInt(netBp);
}

export function interestBreakdownFromNetRate(
  principalKobo: bigint,
  netRateStored: number,
  days: number,
  whtRatePct = WHT_FRACTION * 100,
): InterestBreakdownKobo {
  const netKobo = interestForPeriod(principalKobo, netRateStored, days);
  const grossKobo = grossKoboFromNet(netKobo, whtRatePct);
  const whtKobo = grossKobo - netKobo;
  const netRatePct = ratePctFromStored(netRateStored);
  return {
    grossKobo,
    whtKobo,
    netKobo,
    netRatePct,
    grossRatePct: grossRatePctFromNet(netRatePct, whtRatePct),
    whtRatePct,
  };
}

/** When interestOverrideKobo is set, treat it as **net** interest for full tenor. */
export function interestBreakdownFromNetAmount(
  netKobo: bigint,
  netRateStored: number,
  whtRatePct = WHT_FRACTION * 100,
): InterestBreakdownKobo {
  const grossKobo = grossKoboFromNet(netKobo, whtRatePct);
  const whtKobo = grossKobo - netKobo;
  const netRatePct = ratePctFromStored(netRateStored);
  return {
    grossKobo,
    whtKobo,
    netKobo,
    netRatePct,
    grossRatePct: grossRatePctFromNet(netRatePct, whtRatePct),
    whtRatePct,
  };
}

export function formatRatePair(netRateStored: number, whtRatePct = WHT_FRACTION * 100) {
  const netPct = ratePctFromStored(netRateStored);
  const grossPct = grossRatePctFromNet(netPct, whtRatePct);
  const exempt = whtRatePct <= 0;
  return {
    netRatePct: netPct,
    grossRatePct: grossPct,
    whtRatePct,
    /** e.g. "22.00% net (24.44% gross)" */
    label: exempt
      ? `${netPct.toFixed(2)}% net (WHT exempt)`
      : `${netPct.toFixed(2)}% net (${grossPct.toFixed(2)}% gross)`,
  };
}

/**
 * Admin product input → stored NET rate (`Product.rateBps`) + WHT %.
 * Preferred: `grossRatePct` + `whtRatePct` (net = gross × (1 − wht)).
 * Legacy: `ratePct` / `rateBps` are already net.
 */
export function resolveProductRateInput(input: {
  grossRatePct?: number;
  whtRatePct?: number;
  ratePct?: number;
  rateBps?: number;
}): { rateBps?: number; whtRatePct?: number } {
  const wht = input.whtRatePct;
  if (input.grossRatePct != null) {
    const w = wht ?? WHT_FRACTION * 100;
    return { rateBps: netRateStoredFromGrossPct(input.grossRatePct, w), whtRatePct: w };
  }
  const rateBps =
    input.rateBps ?? (input.ratePct != null ? rateStoredFromPct(input.ratePct) : undefined);
  return { rateBps, whtRatePct: wht };
}

export { RATE_PCT_SCALE, ratePctFromStored, rateStoredFromPct };
