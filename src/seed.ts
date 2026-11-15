import { prisma } from "./lib/prisma.js";
import { hashSecret } from "./lib/crypto.js";
import { ensureUserCall, ensureUserWallet } from "./services/money.js";

async function main() {
  console.log("Seeding Kipit…");

  const { ensureLockFlexRateBands } = await import("./services/lock-flex-rates.js");
  await ensureLockFlexRateBands();

  // B17: four Explore categories only. Soft-retire old slugs by renaming + emptying products.
  const categories = [
    { slug: "treasury-bills", name: "Treasury Bills", sortOrder: 1 },
    { slug: "commercial-papers", name: "Commercial Papers", sortOrder: 2 },
    { slug: "mutual-funds", name: "Mutual Funds", sortOrder: 3 },
    { slug: "bonds", name: "Bonds", sortOrder: 4 },
  ];

  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, sortOrder: c.sortOrder },
    });
  }

  // Remove / close legacy categories and wipe test offerings (B17).
  for (const slug of ["structured-notes", "managed-portfolio", "commodities", "fixed-income"]) {
    const cat = await prisma.productCategory.findUnique({ where: { slug } });
    if (cat) {
      await prisma.product.updateMany({
        where: { categoryId: cat.id },
        data: { availability: "CLOSED" },
      });
    }
  }
  await prisma.product.updateMany({ data: { availability: "CLOSED" } });

  // B25 placeholders until ops uploads final PDFs.
  const legalDefaults = [
    { docKey: "terms", title: "Terms & Conditions", version: "2026.11" },
    { docKey: "privacy", title: "Privacy Policy", version: "2026.11" },
    { docKey: "risk_disclosure", title: "Risk Disclosure", version: "2026.11" },
    { docKey: "product_terms_lock", title: "Product Terms — Kipit Lock", version: "2026.11" },
    { docKey: "product_terms_flex", title: "Product Terms — Kipit Flex", version: "2026.11" },
  ];
  for (const d of legalDefaults) {
    await prisma.legalDocument.upsert({
      where: { docKey_version: { docKey: d.docKey, version: d.version } },
      create: {
        ...d,
        published: true,
        publishedAt: new Date(),
        fileUrl: null,
      },
      update: { title: d.title, published: true, publishedAt: new Date() },
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
      pinHash: await hashSecret("2468"),
      role: "SUPER",
    },
    update: { passwordHash, pinHash: await hashSecret("2468"), role: "SUPER", active: true },
  });

  // Second admin for maker-checker demos
  await prisma.adminUser.upsert({
    where: { email: "ops@kipit.com" },
    create: {
      email: "ops@kipit.com",
      name: "Ops Checker",
      passwordHash: await hashSecret("Kipit1234!"),
      pinHash: await hashSecret("2468"),
      role: "OPERATIONS",
    },
    update: { pinHash: await hashSecret("2468") },
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
