import { prisma } from "./prisma.js";
import { koboToNaira } from "./crypto.js";

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

/**
 * Call Account interest for the rolling last 7 Lagos days (oldest → today).
 * Avoids Mon calendar-week reset looking empty while recent credits exist.
 */
export async function callInterestThisWeek(callAccountId: string) {
  const now = new Date();
  const todayKey = lagosYmd(now);
  const startKey = addYmd(todayKey, -6);

  const since = new Date(now);
  since.setDate(since.getDate() - 12);

  const interestLines = await prisma.journalLine.findMany({
    where: {
      accountId: callAccountId,
      amountKobo: { gt: 0 },
      createdAt: { gte: since },
      entry: { kind: "INTEREST" },
    },
    select: { amountKobo: true, createdAt: true, entry: { select: { description: true } } },
  });

  const byDay = new Map<string, bigint>();
  for (const line of interestLines) {
    // Ignore non-Call daily interest rows if any ever land on the Call account.
    const desc = String(line.entry.description || "");
    if (/maturity\s*interest/i.test(desc)) continue;
    const key = lagosYmd(line.createdAt);
    byDay.set(key, (byDay.get(key) ?? 0n) + line.amountKobo);
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

  return {
    interestThisWeek: koboToNaira(weekTotal),
    interestToday: koboToNaira(todayKobo),
    interestWeekSeries: series,
    interestWeekLabels: labels,
    weekStart: startKey,
    weekEnd: todayKey,
  };
}
