import { prisma } from "./lib/prisma.js";
import { hashSecret } from "./lib/crypto.js";
import { nairaToKobo } from "./lib/crypto.js";
import { ensureUserCall, ensureUserWallet } from "./services/money.js";

async function main() {
  console.log("Seeding Kipit…");

  const bands = [
    { code: "CALL", label: "Call Account", minDays: 0, maxDays: 0, rateBps: 1450 },
    { code: "1-90", label: "1–90 days", minDays: 1, maxDays: 90, rateBps: 1600 },
    { code: "91-120", label: "91–120 days", minDays: 91, maxDays: 120, rateBps: 1750 },
    { code: "121-180", label: "121–180 days", minDays: 121, maxDays: 180, rateBps: 1920 },
    { code: "181-364", label: "181–364 days", minDays: 181, maxDays: 364, rateBps: 2050 },
    { code: "365+", label: "365+ days", minDays: 365, maxDays: null, rateBps: 2150 },
  ];

  for (const b of bands) {
    await prisma.rateBand.upsert({
      where: { code: b.code },
      create: b,
      update: { rateBps: b.rateBps, label: b.label, minDays: b.minDays, maxDays: b.maxDays },
    });
  }

  const categories = [
    { slug: "treasury-bills", name: "Treasury Bills", sortOrder: 1 },
    { slug: "commercial-papers", name: "Commercial Papers", sortOrder: 2 },
    { slug: "structured-notes", name: "Private & Structured Notes", sortOrder: 3 },
    { slug: "managed-portfolio", name: "Managed Portfolio", sortOrder: 4 },
    { slug: "commodities", name: "Commodities", sortOrder: 5 },
  ];

  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, sortOrder: c.sortOrder },
    });
  }

  const tb = await prisma.productCategory.findUniqueOrThrow({ where: { slug: "treasury-bills" } });
  const cp = await prisma.productCategory.findUniqueOrThrow({ where: { slug: "commercial-papers" } });
  const notes = await prisma.productCategory.findUniqueOrThrow({
    where: { slug: "structured-notes" },
  });

  const products = [
    {
      slug: "ngn-364-tbill",
      categoryId: tb.id,
      name: "364-Day T-Bill",
      blurb: "Federal Government treasury bill.",
      description: "Discount instrument held to maturity.",
      rateBps: 1880,
      tenorDays: 364,
      minimumKobo: nairaToKobo(100_000),
      issuer: "DMO / CBN",
      availability: "OPEN" as const,
    },
    {
      slug: "prime-cp-90",
      categoryId: cp.id,
      name: "Prime CP 90",
      blurb: "Short-tenor commercial paper.",
      description: "Investment-grade issuer CP.",
      rateBps: 1950,
      tenorDays: 90,
      minimumKobo: nairaToKobo(250_000),
      issuer: "Prime Issuer Plc",
      availability: "OPEN" as const,
    },
    {
      slug: "private-note-5m",
      categoryId: notes.id,
      name: "Private Note (Large Ticket)",
      blurb: "Adviser-fulfilled structured note.",
      description: "Minimum ₦5m — request access.",
      rateBps: 2100,
      tenorDays: 180,
      minimumKobo: nairaToKobo(5_000_000),
      issuer: "Partner Desk",
      availability: "OPEN" as const,
      largeTicket: true,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      create: p,
      update: {
        name: p.name,
        rateBps: p.rateBps,
        minimumKobo: p.minimumKobo,
        availability: p.availability,
        largeTicket: "largeTicket" in p ? p.largeTicket : false,
      },
    });
  }

  await prisma.learnArticle.upsert({
    where: { slug: "tenor-and-yield" },
    create: {
      slug: "tenor-and-yield",
      title: "Understanding tenor and effective yield",
      summary: "How rate and tenor shape your real return.",
      body: "Tenor is how long your money stays invested. Yield is what you earn over that period.",
      category: "Education",
    },
    update: {},
  });

  await prisma.feedCard.deleteMany({});
  await prisma.feedCard.createMany({
    data: [
      {
        title: "Kipit Fixed Income now settles same-day",
        body: "Maturity payouts land in your wallet within minutes of maturity.",
        kind: "product",
        href: "/invest",
        sortOrder: 1,
      },
      {
        title: "Tier 2 verification is now instant",
        body: "Upgrade with your BVN and NIN to raise your transaction limits.",
        kind: "announcement",
        href: "/verification",
        sortOrder: 2,
      },
    ],
  });

  const adminEmail = "seyi.adeleke@kipit.com";
  const passwordHash = await hashSecret("Kipit1234!");
  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: "Seyi Adeleke",
      passwordHash,
      role: "SUPER",
    },
    update: { passwordHash, role: "SUPER", active: true },
  });

  // Second admin for maker-checker demos
  await prisma.adminUser.upsert({
    where: { email: "ops@kipit.com" },
    create: {
      email: "ops@kipit.com",
      name: "Ops Checker",
      passwordHash: await hashSecret("Kipit1234!"),
      role: "OPERATIONS",
    },
    update: {},
  });

  // Demo consumer matching web/mobile DEMO_IDENTIFIER
  const demoEmail = "adaeze.okonkwo@gmail.com";
  const demoPasswordHash = await hashSecret("Kipit1234!");
  const demoUser = await prisma.user.upsert({
    where: { email: demoEmail },
    create: {
      email: demoEmail,
      passwordHash: demoPasswordHash,
      firstName: "Adaeze",
      surname: "Okonkwo",
      referralCode: "ADADEMO",
      kycTier: "TIER_1",
      pinHash: await hashSecret("2468"),
    },
    update: {
      passwordHash: demoPasswordHash,
      firstName: "Adaeze",
      surname: "Okonkwo",
      kycTier: "TIER_1",
      pinHash: await hashSecret("2468"),
    },
  });
  await prisma.kycProfile.upsert({
    where: { userId: demoUser.id },
    create: {
      userId: demoUser.id,
      bvn: "22123456789",
      bvnName: "OKONKWO ADAEZE",
      status: "APPROVED",
    },
    update: { status: "APPROVED", bvn: "22123456789" },
  });
  // Ensure wallet exists
  await ensureUserWallet(demoUser.id);
  await ensureUserCall(demoUser.id);

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
