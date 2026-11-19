/**
 * B17 / C9 — Explore categories: Treasury Bills, Commercial Papers, Mutual Funds, Bonds.
 * Migrates legacy "Private & Structured Notes" (structured-notes) into Bonds.
 */
import { prisma } from "../lib/prisma.js";

export const B17_EXPLORE_CATEGORIES = [
  { slug: "treasury-bills", name: "Treasury Bills", sortOrder: 1 },
  { slug: "commercial-papers", name: "Commercial Papers", sortOrder: 2 },
  { slug: "mutual-funds", name: "Mutual Funds", sortOrder: 3 },
  { slug: "bonds", name: "Bonds", sortOrder: 4 },
] as const;

export const B17_CATEGORY_SLUGS = B17_EXPLORE_CATEGORIES.map((c) => c.slug);

const LEGACY_TO_BONDS = ["structured-notes", "private-structured-notes", "notes"] as const;

export async function ensureB17ExploreCategories() {
  for (const c of B17_EXPLORE_CATEGORIES) {
    await prisma.productCategory.upsert({
      where: { slug: c.slug },
      create: { ...c },
      update: { name: c.name, sortOrder: c.sortOrder },
    });
  }

  const bonds = await prisma.productCategory.findUnique({ where: { slug: "bonds" } });
  if (!bonds) return;

  // Move offerings out of legacy "Private & Structured Notes" into Bonds.
  for (const slug of LEGACY_TO_BONDS) {
    const legacy = await prisma.productCategory.findUnique({ where: { slug } });
    if (!legacy || legacy.id === bonds.id) continue;
    await prisma.product.updateMany({
      where: { categoryId: legacy.id },
      data: { categoryId: bonds.id },
    });
  }

  // Name-only leftovers (wrong label on an open slug).
  await prisma.productCategory.updateMany({
    where: {
      OR: [
        { name: "Private & Structured Notes" },
        { name: "Private and Structured Notes" },
      ],
      slug: { not: "bonds" },
    },
    data: { name: "Retired — use Bonds" },
  });
}
