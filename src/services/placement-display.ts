import { koboToNaira } from "../lib/crypto.js";
import { accruedInterestToDateKobo } from "./money.js";
import { customerPlanName } from "./lock-flex-rates.js";
import {
  formatRatePair,
  interestBreakdownFromNetAmount,
  interestBreakdownFromNetRate,
} from "./wht.js";

export type PlacementDisplayInput = {
  id: string;
  kind: string;
  name: string;
  status: string;
  principalKobo: bigint;
  rateBps: number;
  tenorDays: number | null;
  startDate: Date;
  maturityDate: Date | null;
  interestOverrideKobo: bigint | null;
  maturityInstruction: string | null;
  planType: "LOCK" | "FLEX" | null;
  interestPayout: "AT_MATURITY" | "UPFRONT" | null;
  lastTopUpAt: Date | null;
  breakRequestedAt: Date | null;
  /** Stored accrual / settled net interest (optional on callers that select it). */
  accruedKobo?: bigint | null;
};

/**
 * Full-tenor interest (gross / WHT / net) — same math as client statements.
 * `interestOverrideKobo` is treated as NET interest for the full tenor.
 */
export function placementExpectedBreakdown(
  p: Pick<PlacementDisplayInput, "principalKobo" | "rateBps" | "tenorDays" | "interestOverrideKobo">,
  whtRatePct = 10,
) {
  if (p.interestOverrideKobo != null) {
    return interestBreakdownFromNetAmount(p.interestOverrideKobo, p.rateBps, whtRatePct);
  }
  if (p.tenorDays != null) {
    return interestBreakdownFromNetRate(p.principalKobo, p.rateBps, p.tenorDays, whtRatePct);
  }
  return null;
}

/** WHT on interest — default 10%; pass product WHT for Explore. */
export function serializePlacementHolding(p: PlacementDisplayInput, whtRatePct = 10) {
  const planType = p.planType ?? (p.kind === "FIXED" ? "LOCK" : null);
  const payout = p.interestPayout ?? "AT_MATURITY";
  const displayName =
    p.kind === "FIXED"
      ? customerPlanName(p.name, planType, p.tenorDays)
      : p.name;
  const pair = formatRatePair(p.rateBps, whtRatePct);
  const expectedNet = placementExpectedBreakdown(p, whtRatePct);
  const accruedNet = accruedInterestToDateKobo(p);
  const accruedBd = interestBreakdownFromNetAmount(accruedNet, p.rateBps, whtRatePct);
  const valueAtMaturityKobo =
    payout === "UPFRONT"
      ? p.principalKobo
      : expectedNet
        ? p.principalKobo + expectedNet.netKobo
        : p.principalKobo;
  return {
    id: p.id,
    kind: p.kind,
    name: displayName,
    planType,
    interestPayout: payout,
    principal: koboToNaira(p.principalKobo),
    principalKobo: p.principalKobo,
    ratePct: pair.netRatePct,
    grossRatePct: pair.grossRatePct,
    rateLabel: pair.label,
    tenorDays: p.tenorDays,
    startDate: p.startDate.toISOString().slice(0, 10),
    maturityDate: p.maturityDate?.toISOString().slice(0, 10) ?? null,
    accrued: koboToNaira(accruedNet),
    accruedGross: koboToNaira(accruedBd.grossKobo),
    accruedWht: koboToNaira(accruedBd.whtKobo),
    accruedNet: koboToNaira(accruedBd.netKobo),
    expectedInterest: expectedNet ? koboToNaira(expectedNet.netKobo) : null,
    expectedGross: expectedNet ? koboToNaira(expectedNet.grossKobo) : null,
    expectedWht: expectedNet ? koboToNaira(expectedNet.whtKobo) : null,
    expectedNet: expectedNet ? koboToNaira(expectedNet.netKobo) : null,
    valueAtMaturity: koboToNaira(valueAtMaturityKobo),
    valueAtMaturityKobo,
    status: p.status,
    maturityInstruction: p.maturityInstruction,
    lastTopUpAt: p.lastTopUpAt?.toISOString() ?? null,
    breakRequestedAt: p.breakRequestedAt?.toISOString() ?? null,
  };
}

/** Drop BigInt fields so Express `res.json` never throws (holding detail 500). */
export function toClientHolding<T extends { principalKobo?: bigint; valueAtMaturityKobo?: bigint }>(
  h: T,
) {
  const { principalKobo: _p, valueAtMaturityKobo: _v, ...rest } = h;
  return rest;
}