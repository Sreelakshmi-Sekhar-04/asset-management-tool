-- Two-step transfer approval.
--
-- Assigning assets to a location is a transfer, and every transfer now waits for an
-- Administrator and then the destination location's manager. This adds:
--   • locations."managerId": the user who approves transfers into that location (unset → the
--     nearest ancestor's manager);
--   • assets."transferStatus" / "transferRequestId": where the asset's latest transfer request
--     stands, for the Transfer status column of the asset register.
--
-- Additive only, and safe to run again on a partly migrated database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetTransferStatus') THEN
    CREATE TYPE "AssetTransferStatus" AS ENUM ('NONE', 'PENDING_ADMIN', 'PENDING_LOCATION_MANAGER', 'APPROVED', 'REJECTED');
  END IF;
END $$;

ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "transferStatus" "AssetTransferStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "transferRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "assets_transferStatus_idx" ON "assets"("transferStatus");

ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "managerId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_managerId_fkey') THEN
    ALTER TABLE "locations" ADD CONSTRAINT "locations_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
