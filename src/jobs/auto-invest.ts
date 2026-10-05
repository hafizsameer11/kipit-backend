import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import {
  nextAutoInvestRunAt,
  resolveFrequency,
  stripFrequencyPrefix,
} from "../lib/auto-invest.js";
import {
  getWalletBalanceKobo,
  moveWalletToCall,
  debitWallet,
} from "../services/money.js";
import { createUserNotification } from "../services/notify.js";

/** Product display name → fixed tenor days (Call handled separately). */
const TENOR_BY_NAME: Record<string, number> = {
  "Kipit Starter": 90,
  "Kipit Fixed Income": 120,
  "Kipit Target Savings": 180,
  "Kipit Growth": 364,
  "Kipit Vault": 365,
};

function rateForTenorDays(
  days: number,
  bands: { minDays: number; maxDays: number | null; rateBps: number }[],
) {
  const band = bands.find((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  return band ?? [...bands].sort((a, b) => a.minDays - b.minDays)[0] ?? null;
}

async function markLastRun(ruleId: string) {
  await prisma.autoInvestRule.update({
    where: { id: ruleId },
    data: { lastRunAt: new Date() },
  });
}

async function executeRule(
  rule: {
    id: string;
    userId: string;
    label: string;
    amountKobo: bigint;
    dayOfMonth: number;
    frequency: string;
  },
  slotKey: string,
) {
  const frequency = resolveFrequency(rule.frequency, rule.label);
  const destination = stripFrequencyPrefix(rule.label).trim() || "Kipit Call Account";
  const amountNaira = koboToNaira(rule.amountKobo);
  const balance = await getWalletBalanceKobo(rule.userId);

  if (balance < rule.amountKobo) {
    await createUserNotification({
      userId: rule.userId,
      title: "Auto-invest skipped",
      body: `Not enough wallet balance for ${destination} (₦${amountNaira.toLocaleString("en-NG")} needed). Top up and we'll try again next run.`,
      href: "/wallet/add-money",
      pushKind: "investment",
      emailKind: "auto_invest_failed",
      amountNaira,
      emailDetail: `Insufficient wallet balance for ${destination}. Top up and we'll try again on the next run.`,
    }).catch(() => undefined);
    await markLastRun(rule.id);
    return { status: "skipped_insufficient" as const };
  }

  const idempotencyKey = `auto-invest-${rule.id}-${slotKey}`;
  const isCall =
    /call account/i.test(destination) || destination.toUpperCase() === "CALL";

  if (isCall) {
    await moveWalletToCall(rule.userId, rule.amountKobo, idempotencyKey);
    await createUserNotification({
      userId: rule.userId,
      title: "Auto-invest completed",
      body: `₦${amountNaira.toLocaleString("en-NG")} moved to ${destination}.`,
      href: "/invest",
      pushKind: "investment",
      emailKind: "investment",
      amountNaira,
      emailDetail: destination,
    }).catch(() => undefined);
    await markLastRun(rule.id);
    return { status: "ok" as const };
  }

  const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" } });
  let tenorDays = TENOR_BY_NAME[destination] ?? 90;
  const matchedBand = bands.find(
    (b) =>
      b.label.toLowerCase() === destination.toLowerCase() ||
      b.code.toLowerCase() === destination.toLowerCase(),
  );
  if (matchedBand) {
    if (matchedBand.maxDays != null && matchedBand.maxDays > 0) {
      tenorDays = matchedBand.maxDays;
    } else if (matchedBand.minDays > 0) {
      tenorDays = matchedBand.minDays;
    }
  }
  if (tenorDays <= 0) tenorDays = 90;

  const band = rateForTenorDays(tenorDays, bands);
  if (!band) {
    await createUserNotification({
      userId: rule.userId,
      title: "Auto-invest skipped",
      body: `No rate band available for ${destination}. Try Call Account or another plan.`,
      href: "/invest",
      pushKind: "investment",
      emailKind: "auto_invest_failed",
      amountNaira,
      emailDetail: `No rate band available for ${destination}. Try Call Account or another plan.`,
    }).catch(() => undefined);
    await markLastRun(rule.id);
    return { status: "skipped_no_band" as const };
  }

  const placementTag = `placement_${nanoid(10)}`;
  const placementAccount = await prisma.ledgerAccount.create({
    data: {
      userId: rule.userId,
      type: "USER_PLACEMENT",
      tag: placementTag,
      currency: "NGN",
      balanceKobo: 0n,
    },
  });

  await debitWallet({
    userId: rule.userId,
    amountKobo: rule.amountKobo,
    kind: "PLACEMENT",
    idempotencyKey,
    description: `Auto-invest: ${destination}`,
    creditAccountId: placementAccount.id,
  });

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + tenorDays);

  await prisma.placement.create({
    data: {
      userId: rule.userId,
      kind: "FIXED",
      name: destination,
      principalKobo: rule.amountKobo,
      rateBps: band.rateBps,
      tenorDays,
      maturityDate,
      maturityInstruction: "WALLET",
      ledgerAccountId: placementAccount.id,
    },
  });

  await createUserNotification({
    userId: rule.userId,
    title: "Auto-invest completed",
    body: `₦${amountNaira.toLocaleString("en-NG")} invested in ${destination}.`,
    href: "/portfolio",
    pushKind: "investment",
    emailKind: "investment",
    amountNaira,
    emailDetail: `${destination} · ${tenorDays} days`,
  }).catch(() => undefined);

  await markLastRun(rule.id);
  return { status: "ok" as const };
}

/** Process due auto-invest rules. Safe to call every minute. */
export async function runAutoInvestJob() {
  const now = new Date();

  // Backfill nextRunAt for older active rules (schedule forward — do not fire all at once).
  const stale = await prisma.autoInvestRule.findMany({
    where: { active: true, nextRunAt: null },
    take: 100,
  });
  for (const rule of stale) {
    const frequency = resolveFrequency(rule.frequency, rule.label);
    await prisma.autoInvestRule.update({
      where: { id: rule.id },
      data: { nextRunAt: nextAutoInvestRunAt(frequency, rule.dayOfMonth, now) },
    });
  }

  const due = await prisma.autoInvestRule.findMany({
    where: {
      active: true,
      nextRunAt: { lte: now },
    },
    take: 50,
    orderBy: { nextRunAt: "asc" },
  });

  let ran = 0;
  let skipped = 0;
  let errors = 0;

  for (const rule of due) {
    const frequency = resolveFrequency(rule.frequency, rule.label);
    const slotKey = (rule.nextRunAt ?? now).toISOString();
    const nextRunAt = nextAutoInvestRunAt(frequency, rule.dayOfMonth, now);

    // Claim the slot so concurrent ticks don't double-run.
    const claimed = await prisma.autoInvestRule.updateMany({
      where: { id: rule.id, nextRunAt: rule.nextRunAt },
      data: { nextRunAt },
    });
    if (claimed.count === 0) continue;

    try {
      const result = await executeRule(rule, slotKey);
      if (result.status === "ok") ran++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error("[auto-invest] rule failed", rule.id, err);
      const amountNaira = koboToNaira(rule.amountKobo);
      const destination = stripFrequencyPrefix(rule.label).trim() || "your plan";
      await createUserNotification({
        userId: rule.userId,
        title: "Auto-invest failed",
        body: "We couldn't complete your scheduled invest. We'll try again on the next run.",
        href: "/invest",
        pushKind: "investment",
        emailKind: "auto_invest_failed",
        amountNaira,
        emailDetail: `We couldn't complete auto-invest into ${destination}. We'll try again on the next run.`,
      }).catch(() => undefined);
    }
  }

  return { due: due.length, ran, skipped, errors };
}
