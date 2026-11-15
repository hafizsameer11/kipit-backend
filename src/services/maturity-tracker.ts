/**
 * C7 — Executive dashboard maturity tracker.
 *
 * Math matches client statements (`interestBreakdownFromNetRate` in wht.ts via
 * `placementExpectedBreakdown`):
 *   - Value at maturity = principal + full-tenor NET interest.
 *   - Upfront Lock: interest is paid at placement, so value at maturity = principal only.
 *   - Tax = gross / WHT / net on the full-tenor interest (rates stored as NET).
 */
import { koboToNaira } from "../lib/crypto.js";
import { accruedInterestToDateKobo } from "./money.js";
import {
  placementExpectedBreakdown,
  type PlacementDisplayInput,
} from "./placement-display.js";
import { displayPlanName } from "./lock-flex-rates.js";
import { interestBreakdownFromNetAmount } from "./wht.js";

export type TrackerBucket = "lock" | "flex" | "explore";
export type TrackerPayout = "upfront" | "atMaturity";

export type TrackerPlacement = PlacementDisplayInput & {
  breakCreditAt: Date | null;
  product?: { name: string; whtRatePct: number } | null;
  user?: { firstName: string; surname: string } | null;
};

type MoneyKobo = {
  count: number;
  principal: bigint;
  interestGross: bigint;
  interestWht: bigint;
  interestNet: bigint;
  /** Net interest already paid to the client at placement (upfront Lock). */
  upfrontInterestPaid: bigint;
  /** Principal + net interest payable at maturity (upfront → principal only). */
  valueAtMaturity: bigint;
};

const emptyMoney = (): MoneyKobo => ({
  count: 0,
  principal: 0n,
  interestGross: 0n,
  interestWht: 0n,
  interestNet: 0n,
  upfrontInterestPaid: 0n,
  valueAtMaturity: 0n,
});

function addMoney(target: MoneyKobo, row: PlacementMoney) {
  target.count += 1;
  target.principal += row.principal;
  target.interestGross += row.interestGross;
  target.interestWht += row.interestWht;
  target.interestNet += row.interestNet;
  target.upfrontInterestPaid += row.upfrontInterestPaid;
  target.valueAtMaturity += row.valueAtMaturity;
}

function moneyToNaira(m: MoneyKobo) {
  return {
    count: m.count,
    principal: koboToNaira(m.principal),
    interestGross: koboToNaira(m.interestGross),
    interestWht: koboToNaira(m.interestWht),
    interestNet: koboToNaira(m.interestNet),
    upfrontInterestPaid: koboToNaira(m.upfrontInterestPaid),
    valueAtMaturity: koboToNaira(m.valueAtMaturity),
  };
}

export type PlacementMoney = {
  bucket: TrackerBucket;
  payout: TrackerPayout;
  principal: bigint;
  interestGross: bigint;
  interestWht: bigint;
  interestNet: bigint;
  upfrontInterestPaid: bigint;
  valueAtMaturity: bigint;
  whtRatePct: number;
};

export function trackerBucketOf(p: Pick<PlacementDisplayInput, "kind" | "planType">): TrackerBucket {
  if (p.kind === "EXPLORE") return "explore";
  return p.planType === "FLEX" ? "flex" : "lock";
}

/** Full-tenor money for one placement (kobo). */
export function placementMaturityMoney(
  p: PlacementDisplayInput,
  whtRatePct = 10,
): PlacementMoney {
  const payout: TrackerPayout = p.interestPayout === "UPFRONT" ? "upfront" : "atMaturity";
  let bd = placementExpectedBreakdown(p, whtRatePct);
  // Settled plans: the stored accrued figure is what was actually paid (net).
  if (p.status === "MATURED" && p.accruedKobo != null && p.accruedKobo > 0n) {
    bd = interestBreakdownFromNetAmount(p.accruedKobo, p.rateBps, whtRatePct);
  }
  const gross = bd?.grossKobo ?? 0n;
  const wht = bd?.whtKobo ?? 0n;
  const net = bd?.netKobo ?? 0n;
  const upfrontPaid = payout === "upfront" ? net : 0n;
  return {
    bucket: trackerBucketOf(p),
    payout,
    principal: p.principalKobo,
    interestGross: gross,
    interestWht: wht,
    interestNet: net,
    upfrontInterestPaid: upfrontPaid,
    valueAtMaturity: payout === "upfront" ? p.principalKobo : p.principalKobo + net,
    whtRatePct,
  };
}

/* ── Business days (Mon–Fri; public holidays not modelled) ───────────── */

export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export function businessDaysBetween(from: Date, to: Date) {
  if (to <= from) return 0;
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  let n = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

export const FLEX_BREAK_SLA_BUSINESS_DAYS = 3;

const PLAN_LABEL: Record<TrackerBucket, string> = {
  lock: "Kipit Lock",
  flex: "Kipit Flex",
  explore: "Explore",
};

/** Active placements → executive maturity tracker summary (naira). */
export function buildMaturityTracker(placements: TrackerPlacement[], now = new Date()) {
  const total = emptyMoney();
  const byPlan: Record<TrackerBucket, { total: MoneyKobo; upfront: MoneyKobo; atMaturity: MoneyKobo }> = {
    lock: { total: emptyMoney(), upfront: emptyMoney(), atMaturity: emptyMoney() },
    flex: { total: emptyMoney(), upfront: emptyMoney(), atMaturity: emptyMoney() },
    explore: { total: emptyMoney(), upfront: emptyMoney(), atMaturity: emptyMoney() },
  };
  const byPayout: Record<TrackerPayout, MoneyKobo> = {
    upfront: emptyMoney(),
    atMaturity: emptyMoney(),
  };
  const payableRemaining: Record<TrackerBucket, bigint> = { lock: 0n, flex: 0n, explore: 0n };
  const payableWht: Record<TrackerBucket, bigint> = { lock: 0n, flex: 0n, explore: 0n };
  const tax = new Map<
    string,
    { product: string; bucket: TrackerBucket; whtRatePct: number; money: MoneyKobo }
  >();

  const breaks = {
    count: 0,
    principal: 0n,
    accruedNet: 0n,
    forfeitedNet: 0n,
    creditNet: 0n,
    payout: 0n,
    withinSla: 0,
    overdue: 0,
    items: [] as {
      id: string;
      name: string;
      client: string | null;
      principal: number;
      accruedNet: number;
      creditNet: number;
      payout: number;
      breakRequestedAt: string;
      creditDueAt: string;
      businessDaysElapsed: number;
      businessDaysLeft: number;
      overdue: boolean;
    }[],
  };

  for (const p of placements) {
    const whtRatePct = p.product?.whtRatePct ?? 10;
    const row = placementMaturityMoney(p, whtRatePct);
    addMoney(total, row);
    addMoney(byPlan[row.bucket].total, row);
    addMoney(byPlan[row.bucket][row.payout], row);
    addMoney(byPayout[row.payout], row);

    // Interest still to pay at maturity (net, remaining after accrual). Upfront is already paid.
    if (row.payout === "atMaturity") {
      const accrued = accruedInterestToDateKobo(p, now);
      const remaining = row.interestNet > accrued ? row.interestNet - accrued : 0n;
      payableRemaining[row.bucket] += remaining;
      payableWht[row.bucket] += interestBreakdownFromNetAmount(
        remaining,
        p.rateBps,
        whtRatePct,
      ).whtKobo;
    }

    const productLabel =
      row.bucket === "explore"
        ? (p.product?.name ?? p.name)
        : displayPlanName(row.bucket === "flex" ? "FLEX" : "LOCK", p.tenorDays);
    const taxKey = `${row.bucket}:${row.bucket === "explore" ? productLabel : PLAN_LABEL[row.bucket]}`;
    let t = tax.get(taxKey);
    if (!t) {
      t = {
        product: row.bucket === "explore" ? productLabel : PLAN_LABEL[row.bucket],
        bucket: row.bucket,
        whtRatePct,
        money: emptyMoney(),
      };
      tax.set(taxKey, t);
    }
    addMoney(t.money, row);

    if (p.status === "ACTIVE" && p.planType === "FLEX" && p.breakRequestedAt) {
      const accruedNet = accruedInterestToDateKobo(p, now);
      const creditNet = accruedNet / 2n; // matches flex-break job: 50% forfeited
      const creditDueAt = addBusinessDays(p.breakRequestedAt, FLEX_BREAK_SLA_BUSINESS_DAYS);
      const elapsed = businessDaysBetween(p.breakRequestedAt, now);
      const overdue = now > creditDueAt;
      breaks.count += 1;
      breaks.principal += p.principalKobo;
      breaks.accruedNet += accruedNet;
      breaks.forfeitedNet += accruedNet - creditNet;
      breaks.creditNet += creditNet;
      breaks.payout += p.principalKobo + creditNet;
      if (overdue) breaks.overdue += 1;
      else breaks.withinSla += 1;
      breaks.items.push({
        id: p.id,
        name: productLabel,
        client: p.user ? `${p.user.firstName} ${p.user.surname}` : null,
        principal: koboToNaira(p.principalKobo),
        accruedNet: koboToNaira(accruedNet),
        creditNet: koboToNaira(creditNet),
        payout: koboToNaira(p.principalKobo + creditNet),
        breakRequestedAt: p.breakRequestedAt.toISOString(),
        creditDueAt: (p.breakCreditAt && p.breakCreditAt > creditDueAt
          ? p.breakCreditAt
          : creditDueAt
        ).toISOString(),
        businessDaysElapsed: elapsed,
        businessDaysLeft: Math.max(0, FLEX_BREAK_SLA_BUSINESS_DAYS - elapsed),
        overdue,
      });
    }
  }

  breaks.items.sort((a, b) => a.breakRequestedAt.localeCompare(b.breakRequestedAt));

  const payableTotal = payableRemaining.lock + payableRemaining.flex + payableRemaining.explore;
  const payableWhtTotal = payableWht.lock + payableWht.flex + payableWht.explore;

  return {
    /** Value at maturity = principal + full-tenor NET interest (upfront Lock = principal only). */
    totals: moneyToNaira(total),
    byPlan: {
      lock: planToNaira(byPlan.lock),
      flex: planToNaira(byPlan.flex),
      explore: planToNaira(byPlan.explore),
    },
    byPayout: {
      upfront: moneyToNaira(byPayout.upfront),
      atMaturity: moneyToNaira(byPayout.atMaturity),
    },
    /** Net interest still to pay at maturity (excludes upfront, already paid). */
    interestPayable: {
      total: koboToNaira(payableTotal),
      lock: koboToNaira(payableRemaining.lock),
      flex: koboToNaira(payableRemaining.flex),
      explore: koboToNaira(payableRemaining.explore),
      wht: koboToNaira(payableWhtTotal),
    },
    pendingFlexBreaks: {
      count: breaks.count,
      principal: koboToNaira(breaks.principal),
      accruedNet: koboToNaira(breaks.accruedNet),
      forfeitedNet: koboToNaira(breaks.forfeitedNet),
      creditNet: koboToNaira(breaks.creditNet),
      payout: koboToNaira(breaks.payout),
      withinSla: breaks.withinSla,
      overdue: breaks.overdue,
      slaBusinessDays: FLEX_BREAK_SLA_BUSINESS_DAYS,
      items: breaks.items.slice(0, 25),
    },
    taxByProduct: [...tax.values()]
      .map((t) => ({
        product: t.product,
        planType: t.bucket,
        whtRatePct: t.whtRatePct,
        count: t.money.count,
        principal: koboToNaira(t.money.principal),
        gross: koboToNaira(t.money.interestGross),
        wht: koboToNaira(t.money.interestWht),
        net: koboToNaira(t.money.interestNet),
      }))
      .sort((a, b) => b.gross - a.gross),
  };
}

function planToNaira(p: { total: MoneyKobo; upfront: MoneyKobo; atMaturity: MoneyKobo }) {
  return {
    total: moneyToNaira(p.total),
    upfront: moneyToNaira(p.upfront),
    atMaturity: moneyToNaira(p.atMaturity),
  };
}

export type MaturityTrackerSummary = ReturnType<typeof buildMaturityTracker>;
