-- Scale stored rates from percent×100 (2 d.p.) to percent×10000 (4 d.p.).
-- Guard: only multiply values that still look like the old scale (< 50_000 ≈ 500%).

UPDATE "Placement"
SET "rateBps" = "rateBps" * 100
WHERE "rateBps" IS NOT NULL AND "rateBps" < 50000;

UPDATE "RateBand"
SET "rateBps" = "rateBps" * 100
WHERE "rateBps" < 50000;

UPDATE "Product"
SET "rateBps" = "rateBps" * 100
WHERE "rateBps" < 50000;

UPDATE "RateChangeRequest"
SET
  "proposedBps" = CASE WHEN "proposedBps" < 50000 THEN "proposedBps" * 100 ELSE "proposedBps" END,
  "previousBps" = CASE
    WHEN "previousBps" IS NOT NULL AND "previousBps" < 50000 THEN "previousBps" * 100
    ELSE "previousBps"
  END;
