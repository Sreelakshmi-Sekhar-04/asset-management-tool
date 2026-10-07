-- Transfer receipt after approval.
--
-- Both approvals now only authorise a transfer: the asset stays where it is until the destination
-- confirms what actually arrived and in what condition. The shipment is recorded in the existing
-- transfers / transfer_lines / transfer_receipts / transfer_exceptions tables:
--   • transfers."approvalRequestId" is no longer unique: a request that moves assets from two
--     source locations becomes two shipments;
--   • transfer_receipts."receivedAt": when the goods arrived (entered by the receiver);
--   • transfer_lines."receivedCondition" / "receivedAt": the condition recorded per asset.
--
-- Before this change "APPROVED" meant the asset had already moved; those assets become RECEIVED,
-- so nothing already transferred is asked to be received again.
--
-- Additive only, and safe to run again on a partly migrated database.
DROP INDEX IF EXISTS "transfers_approvalRequestId_key";
CREATE INDEX IF NOT EXISTS "transfers_approvalRequestId_idx" ON "transfers"("approvalRequestId");

ALTER TABLE "transfer_receipts" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "transfer_lines" ADD COLUMN IF NOT EXISTS "receivedCondition" TEXT;
ALTER TABLE "transfer_lines" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);

UPDATE "assets" a SET "transferStatus" = 'RECEIVED'
 WHERE a."transferStatus" = 'APPROVED'
   AND NOT EXISTS (SELECT 1 FROM "transfer_lines" tl WHERE tl."assetId" = a."id" AND tl."status" IN ('PENDING_APPROVAL', 'IN_TRANSIT'));
