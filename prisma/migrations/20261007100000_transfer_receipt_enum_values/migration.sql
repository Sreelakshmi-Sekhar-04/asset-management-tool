-- Transfer receipt: two more values for where an asset's transfer stands.
--   RECEIVED      the destination confirmed the asset arrived (the asset has moved)
--   NOT_RECEIVED  the destination reported it did not arrive (open exception; the asset stays put)
--
-- Enum values only. PostgreSQL refuses to use a new enum value in the transaction that added it
-- (error 55P04), so the data changes that use them are in the next migration.
-- Safe to run again.
ALTER TYPE "AssetTransferStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "AssetTransferStatus" ADD VALUE IF NOT EXISTS 'NOT_RECEIVED';
