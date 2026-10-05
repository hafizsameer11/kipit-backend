import { prisma } from "./prisma.js";
import { koboToNaira } from "./crypto.js";

const LAGOS = "Africa/Lagos";
const WD_MON0: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function lagosYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LAGOS }).format(d);
}

function lagosWeekdayMon0(d: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: LAGOS,
    weekday: "short",
  }).format(d);
  return WD_MON0[wd] ?? 0;
}

/** Add calendar days to a YYYY-MM-DD key (Lagos civil date). */
function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d! + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}

/**
 * Call Account interest for the current Mon–Sun week in Africa/Lagos.
 * Series is always length 7 (Mon→Sun); future weekdays stay 0.
 */
export async function callInterestThisWeek(callAccountId: string) {
  const now = new Date();
  const todayKey = lagosYmd(now);
  const mon0 = lagosWeekdayMon0(now);
  const mondayKey = addYmd(todayKey, -mon0);
  const sundayKey = addYmd(mondayKey, 6);

  // Fetch a bit of buffer so UTC/Lagos edges don't drop Monday credits.
  const since = new Date(now);
  since.setDate(since.getDate() - 10);

  const interestLines = await prisma.journalLine.findMany({
    where: {
      accountId: callAccountId,
      amountKobo: { gt: 0 },
      createdAt: { gte: since },
      entry: { kind: "INTEREST" },
    },
    select: { amountKobo: true, createdAt: true },
  });

  const byDay = new Map<string, bigint>();
  for (const line of interestLines) {
    const key = lagosYmd(line.createdAt);
    byDay.set(key, (byDay.get(key) ?? 0n) + line.amountKobo);
  }

  const series: number[] = [];
  let weekTotal = 0n;
  for (let i = 0; i < 7; i++) {
    const key = addYmd(mondayKey, i);
    const kobo = byDay.get(key) ?? 0n;
    weekTotal += kobo;
    series.push(koboToNaira(kobo));
  }

  const todayKobo = byDay.get(todayKey) ?? 0n;

  return {
    interestThisWeek: koboToNaira(weekTotal),
    interestToday: koboToNaira(todayKobo),
    interestWeekSeries: series,
    weekStart: mondayKey,
    weekEnd: sundayKey,
  };
}
