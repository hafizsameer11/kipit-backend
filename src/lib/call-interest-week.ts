import { prisma } from "./prisma.js";
import { koboToNaira } from "./crypto.js";
import { ensureUserCall, ensureUserWallet } from "../services/money.js";

const LAGOS = "Africa/Lagos";

function lagosYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LAGOS }).format(d);
}

function lagosWeekdayShort(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LAGOS,
    weekday: "short",
  }).format(d);
}

/** Add calendar days to a YYYY-MM-DD key. */
function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d! + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}

function ymdToDateUtcNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
}

function addKobo(map: Map<string, bigint>, key: string, amount: bigint) {
  if (amount <= 0n) return;
  map.set(key, (map.get(key) ?? 0n) + amount);
}

/**
 * Overall interest for the rolling last 7 Lagos days (oldest → today):
 *  - Call Account daily interest
 *  - Fixed/Explore maturity interest (accrued on matured placements)
 *  - Any other INTEREST credits to wallet/call (legacy), excluding duplicates of the above
 */
export async function portfolioInterestThisWeek(userId: string) {
  const now = new Date();
  const todayKey = lagosYmd(now);
  const startKey = addYmd(todayKey, -6);

  const since = new Date(now);
  since.setDate(since.getDate() - 12);

  const wallet = await ensureUserWallet(userId);
  const call = await ensureUserCall(userId);

  const byDay = new Map<string, bigint>();
  const callByDay = new Map<string, bigint>();

  // 1) Call daily interest (+ any other INTEREST on Call).
  const callInterest = await prisma.journalLine.findMany({
    where: {
      accountId: call.id,
      amountKobo: { gt: 0 },
      createdAt: { gte: since },
      entry: { kind: "INTEREST" },
    },
    select: { amountKobo: true, createdAt: true, entry: { select: { description: true } } },
  });
  for (const line of callInterest) {
    const desc = String(line.entry.description || "");
    if (/maturity/i.test(desc)) continue;
    const key = lagosYmd(line.createdAt);
    addKobo(byDay, key, line.amountKobo);
    addKobo(callByDay, key, line.amountKobo);
  }

  // 2) Maturity interest from placements settled in-window (covers new 3-line MATURITY journals).
  const matured = await prisma.placement.findMany({
    where: {
      userId,
      status: "MATURED",
      accruedKobo: { gt: 0 },
      OR: [{ maturityDate: { gte: since } }, { updatedAt: { gte: since } }],
    },
    select: { accruedKobo: true, maturityDate: true, updatedAt: true },
  });
  for (const p of matured) {
    const when = p.maturityDate ?? p.updatedAt;
    const key = lagosYmd(when);
    if (key < startKey || key > todayKey) continue;
    addKobo(byDay, key, p.accruedKobo);
  }

  // 3) Legacy wallet INTEREST credits (e.g. old "maturity interest funding") not already
  //    represented by placement accrued above for that day — only add if no matured interest that day.
  const walletInterest = await prisma.journalLine.findMany({
    where: {
      accountId: wallet.id,
      amountKobo: { gt: 0 },
      createdAt: { gte: since },
      entry: { kind: "INTEREST" },
    },
    select: { amountKobo: true, createdAt: true, entry: { select: { description: true } } },
  });
  const maturedDays = new Set(
    matured.map((p) => lagosYmd(p.maturityDate ?? p.updatedAt)).filter((k) => k >= startKey && k <= todayKey),
  );
  for (const line of walletInterest) {
    const key = lagosYmd(line.createdAt);
    if (key < startKey || key > todayKey) continue;
    // Prefer placement accrued when we matured that day; skip legacy duplicate INTEREST.
    if (maturedDays.has(key) && /maturity/i.test(String(line.entry.description || ""))) continue;
    if (!maturedDays.has(key)) {
      addKobo(byDay, key, line.amountKobo);
    }
  }

  const series: number[] = [];
  const labels: string[] = [];
  let weekTotal = 0n;
  for (let i = 0; i < 7; i++) {
    const key = addYmd(startKey, i);
    const kobo = byDay.get(key) ?? 0n;
    weekTotal += kobo;
    series.push(koboToNaira(kobo));
    labels.push(lagosWeekdayShort(ymdToDateUtcNoon(key)).slice(0, 1));
  }

  const todayKobo = byDay.get(todayKey) ?? 0n;
  const callTodayKobo = callByDay.get(todayKey) ?? 0n;

  return {
    interestThisWeek: koboToNaira(weekTotal),
    interestToday: koboToNaira(todayKobo),
    /** Call-only today — for Call Account “earned today”. */
    callInterestToday: koboToNaira(callTodayKobo),
    interestWeekSeries: series,
    interestWeekLabels: labels,
    weekStart: startKey,
    weekEnd: todayKey,
  };
}

/** @deprecated Prefer portfolioInterestThisWeek — kept for call-site compatibility. */
export async function callInterestThisWeek(callAccountId: string) {
  const call = await prisma.ledgerAccount.findUnique({ where: { id: callAccountId } });
  if (!call?.userId) {
    return {
      interestThisWeek: 0,
      interestToday: 0,
      callInterestToday: 0,
      interestWeekSeries: [0, 0, 0, 0, 0, 0, 0],
      interestWeekLabels: ["M", "T", "W", "T", "F", "S", "S"],
      weekStart: lagosYmd(new Date()),
      weekEnd: lagosYmd(new Date()),
    };
  }
  return portfolioInterestThisWeek(call.userId);
}
