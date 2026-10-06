-- Organization context, and transfer handled from the asset register (part two: tables and data).
-- The new enum values are added by 20261006000000_org_enum_values, which must commit first:
-- PostgreSQL refuses to use a new enum value in the transaction that created it.
--
-- Every statement is written so the migration can be applied to a database that already has
-- part of it (a repair re-run), as described in docs/DATABASE.md.

-- ── Departments belong to an organization (null = shared by every organization) ──
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_organizationId_fkey') THEN
    ALTER TABLE "departments"
      ADD CONSTRAINT "departments_organizationId_fkey" FOREIGN KEY ("organizationId")
      REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "departments_organizationId_idx" ON "departments"("organizationId");

-- ── Existing roots become organizations, and existing departments join the only one ──
UPDATE "locations" SET "type" = 'ORGANIZATION' WHERE "parentId" IS NULL AND "type" <> 'ORGANIZATION';
UPDATE "departments" d SET "organizationId" = (SELECT l.id FROM "locations" l WHERE l."parentId" IS NULL)
 WHERE d."organizationId" IS NULL
   AND (SELECT count(*) FROM "locations" l WHERE l."parentId" IS NULL) = 1;

-- ── The separate transfer workflow is retired ────────────────────────────────
-- Assignment and transfer are now one action on the asset register, so no new transfers
-- are raised. Transfers that were still open would otherwise lock their assets forever,
-- with no screen left to resolve them, so they are closed here. Every completed transfer,
-- its lines, receipts, exceptions and movements stay exactly as they are: the history of
-- an asset is never rewritten.
UPDATE "transfer_lines" SET "status" = 'CANCELLED', "resolvedAt" = now(),
       "remark" = coalesce("remark" || ' · ', '') || 'Closed when transfer moved into the asset register'
 WHERE "status" IN ('DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT');
UPDATE "transfers" SET "status" = 'CANCELLED', "cancelledAt" = now()
 WHERE "status" IN ('DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT', 'PARTIALLY_RECEIVED');
UPDATE "approval_tasks" SET "status" = 'SKIPPED', "decidedAt" = now(),
       "comment" = coalesce("comment" || ' · ', '') || 'Transfer workflow retired'
 WHERE "status" IN ('WAITING', 'PENDING')
   AND "requestId" IN (SELECT id FROM "approval_requests" WHERE "action" = 'TRANSFER' AND "status" = 'PENDING');
UPDATE "approval_requests" SET "status" = 'CANCELLED', "decidedAt" = now()
 WHERE "action" = 'TRANSFER' AND "status" = 'PENDING';
-- Approval policies for the retired action no longer match anything; they are kept but switched off.
UPDATE "approval_policies" SET "active" = false WHERE "action" = 'TRANSFER' AND "active";
