-- C4 soft-delete: hide Explore products without removing placements.
ALTER TABLE "Product" ADD COLUMN "archivedAt" TIMESTAMP(3);
