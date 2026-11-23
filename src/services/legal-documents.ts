/**
 * B25 — ensure published legal document placeholders exist.
 * fileUrl stays null until ops uploads the final PDFs.
 */
import { prisma } from "../lib/prisma.js";

export const LEGAL_DOC_DEFAULTS = [
  { docKey: "terms", title: "Terms & Conditions", version: "2026.11" },
  { docKey: "privacy", title: "Privacy Policy", version: "2026.11" },
  { docKey: "risk_disclosure", title: "Risk Disclosure", version: "2026.11" },
  { docKey: "product_terms_lock", title: "Product Terms — Kipit Lock", version: "2026.11" },
  { docKey: "product_terms_flex", title: "Product Terms — Kipit Flex", version: "2026.11" },
] as const;

export async function ensureLegalDocuments() {
  for (const d of LEGAL_DOC_DEFAULTS) {
    await prisma.legalDocument.upsert({
      where: { docKey_version: { docKey: d.docKey, version: d.version } },
      create: {
        ...d,
        published: true,
        publishedAt: new Date(),
        fileUrl: null,
      },
      update: { title: d.title, published: true },
    });
  }
}
