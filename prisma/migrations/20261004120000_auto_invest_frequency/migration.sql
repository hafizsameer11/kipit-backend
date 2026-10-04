-- Additive frequency column for auto-invest (default Monthly). App-safe: optional on create; GET always returns it.
ALTER TABLE "AutoInvestRule" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'Monthly';

-- Backfill from legacy label prefix "Weekly · …" / "Every 2 weeks · …" / "Monthly · …"
UPDATE "AutoInvestRule"
SET "frequency" = CASE
  WHEN "label" LIKE 'Weekly ·%' THEN 'Weekly'
  WHEN "label" LIKE 'Every 2 weeks ·%' THEN 'Every 2 weeks'
  WHEN "label" LIKE 'Monthly ·%' THEN 'Monthly'
  ELSE "frequency"
END;
