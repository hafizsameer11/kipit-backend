-- B25 Legal documents CMS
CREATE TABLE IF NOT EXISTS "LegalDocument" (
  "id" TEXT NOT NULL,
  "docKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "fileUrl" TEXT,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LegalDocument_docKey_version_key" ON "LegalDocument"("docKey", "version");
CREATE INDEX IF NOT EXISTS "LegalDocument_docKey_published_idx" ON "LegalDocument"("docKey", "published");
