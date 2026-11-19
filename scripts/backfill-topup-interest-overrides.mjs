/**
 * Backfill interestOverrideKobo for active AT_MATURITY fixed plans that were topped up
 * before the B26/C7 fix. Reconstructs from placement ledger credits after startDate.
 *
 * Run: node scripts/backfill-topup-interest-overrides.mjs
 * Requires DATABASE_URL in env / .env
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function interestForPeriod(principalKobo, rateBps, days) {
  if (days <= 0 || principalKobo <= 0n || rateBps <= 0) return 0n;
  return (principalKobo * BigInt(rateBps) * BigInt(days)) / (1_000_000n * 365n);
}

async function main() {
  const plans = await prisma.placement.findMany({
    where: {
      status: "ACTIVE",
      kind: "FIXED",
      lastTopUpAt: { not: null },
      OR: [{ interestPayout: null }, { interestPayout: "AT_MATURITY" }],
    },
  });
  console.log(`candidates ${plans.length}`);
  let updated = 0;
  for (const p of plans) {
    if (!p.tenorDays || !p.maturityDate || !p.ledgerAccountId) continue;

    // Credits into the placement ledger after creation ≈ top-ups (+ initial fund).
    const lines = await prisma.ledgerLine.findMany({
      where: {
        accountId: p.ledgerAccountId,
        side: "CREDIT",
        entry: { createdAt: { gte: p.startDate } },
      },
      include: { entry: true },
      orderBy: { entry: { createdAt: "asc" } },
    });

    if (lines.length < 2) continue; // only initial funding

    const initial = lines[0].amountKobo;
    let expected = interestForPeriod(initial, p.rateBps, p.tenorDays);
    for (let i = 1; i < lines.length; i++) {
      const top = lines[i].amountKobo;
      const at = lines[i].entry.createdAt;
      const msLeft = p.maturityDate.getTime() - at.getTime();
      const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
      expected += interestForPeriod(top, p.rateBps, daysLeft);
    }

    if (p.interestOverrideKobo != null && p.interestOverrideKobo === expected) continue;

    await prisma.placement.update({
      where: { id: p.id },
      data: { interestOverrideKobo: expected },
    });
    updated += 1;
    console.log(`updated ${p.id} ${p.name} override=${expected}`);
  }
  console.log(`done updated=${updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
