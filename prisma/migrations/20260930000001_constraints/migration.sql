-- Data-layer guarantees for Phase 1 invariants. These hold even if application
-- code is bypassed (direct SQL, a buggy endpoint, a future integration).

-- ── Normalised duplicate keys (serial: case-insensitive + trimmed) ──
CREATE OR REPLACE FUNCTION itam_normalise_asset_keys() RETURNS trigger AS $$
BEGIN
  NEW."serialNumber" := NULLIF(btrim(NEW."serialNumber"), '');
  NEW."serialNormalized" := lower(NEW."serialNumber");
  NEW."legacyTag" := NULLIF(btrim(NEW."legacyTag"), '');
  NEW."legacyTagNormalized" := lower(NEW."legacyTag");
  NEW."hostname" := NULLIF(btrim(NEW."hostname"), '');
  NEW."hostnameNormalized" := lower(NEW."hostname");
  NEW."ipAddress" := NULLIF(btrim(NEW."ipAddress"), '');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assets_normalise_keys
  BEFORE INSERT OR UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION itam_normalise_asset_keys();

-- ── Asset ID and Transfer number are immutable; assets are never deleted ──
CREATE OR REPLACE FUNCTION itam_guard_asset_update() RETURNS trigger AS $$
BEGIN
  IF NEW."assetCode" IS DISTINCT FROM OLD."assetCode" THEN
    RAISE EXCEPTION 'ASSET_ID_IMMUTABLE: Asset ID % cannot be changed', OLD."assetCode" USING ERRCODE = 'P0001';
  END IF;
  -- INV-3: a retired asset cannot be moved, assigned, status-changed or edited (remarks excepted)
  IF OLD."status" = 'RETIRED' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
    OR NEW."holderType" IS DISTINCT FROM OLD."holderType"
    OR NEW."holderEmployeeId" IS DISTINCT FROM OLD."holderEmployeeId"
    OR NEW."holderDepartmentId" IS DISTINCT FROM OLD."holderDepartmentId"
    OR NEW."holderLocationId" IS DISTINCT FROM OLD."holderLocationId"
    OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
    OR NEW."make" IS DISTINCT FROM OLD."make"
    OR NEW."model" IS DISTINCT FROM OLD."model"
    OR NEW."serialNumber" IS DISTINCT FROM OLD."serialNumber"
    OR NEW."hostname" IS DISTINCT FROM OLD."hostname"
    OR NEW."ipAddress" IS DISTINCT FROM OLD."ipAddress"
    OR NEW."macAddress" IS DISTINCT FROM OLD."macAddress"
    OR NEW."legacyTag" IS DISTINCT FROM OLD."legacyTag"
    OR NEW."purchaseDate" IS DISTINCT FROM OLD."purchaseDate"
    OR NEW."purchaseCost" IS DISTINCT FROM OLD."purchaseCost"
    OR NEW."vendor" IS DISTINCT FROM OLD."vendor"
    OR NEW."warrantyEnd" IS DISTINCT FROM OLD."warrantyEnd"
    OR NEW."condition" IS DISTINCT FROM OLD."condition"
  ) THEN
    RAISE EXCEPTION 'ASSET_RETIRED: Asset % is retired and cannot be changed', OLD."assetCode" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assets_guard_update BEFORE UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION itam_guard_asset_update();

CREATE OR REPLACE FUNCTION itam_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DELETE_FORBIDDEN: rows in % cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assets_no_delete BEFORE DELETE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION itam_forbid_delete();

CREATE OR REPLACE FUNCTION itam_guard_transfer_no() RETURNS trigger AS $$
BEGIN
  IF NEW."transferNo" IS DISTINCT FROM OLD."transferNo" THEN
    RAISE EXCEPTION 'TRANSFER_NO_IMMUTABLE: transfer number cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER transfers_guard_no BEFORE UPDATE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION itam_guard_transfer_no();

-- ── Holder / status invariants ──
ALTER TABLE "assets" ADD CONSTRAINT "inv1_assigned_has_holder"
  CHECK ("status" <> 'ASSIGNED' OR "holderType" IS NOT NULL);
ALTER TABLE "assets" ADD CONSTRAINT "inv2_holder_implies_assigned_or_repair"
  CHECK ("holderType" IS NULL OR "status" IN ('ASSIGNED', 'UNDER_REPAIR'));
ALTER TABLE "assets" ADD CONSTRAINT "inv3_retired_no_holder"
  CHECK ("status" <> 'RETIRED' OR "holderType" IS NULL);
ALTER TABLE "assets" ADD CONSTRAINT "location_required_unless_retired"
  CHECK ("status" = 'RETIRED' OR "locationId" IS NOT NULL);
ALTER TABLE "assets" ADD CONSTRAINT "holder_reference_consistent" CHECK (
     ("holderType" IS NULL AND "holderEmployeeId" IS NULL AND "holderDepartmentId" IS NULL AND "holderLocationId" IS NULL)
  OR ("holderType" = 'EMPLOYEE' AND "holderEmployeeId" IS NOT NULL AND "holderDepartmentId" IS NULL AND "holderLocationId" IS NULL)
  OR ("holderType" = 'DEPARTMENT' AND "holderDepartmentId" IS NOT NULL AND "holderEmployeeId" IS NULL AND "holderLocationId" IS NULL)
  OR ("holderType" = 'LOCATION' AND "holderLocationId" IS NOT NULL AND "holderEmployeeId" IS NULL AND "holderDepartmentId" IS NULL)
);
ALTER TABLE "assets" ADD CONSTRAINT "purchase_cost_non_negative" CHECK ("purchaseCost" IS NULL OR "purchaseCost" >= 0);

-- ── BR-TRF-1 / INV-4: an asset can be on at most one open transfer line ──
CREATE UNIQUE INDEX "transfer_lines_one_open_per_asset"
  ON "transfer_lines" ("assetId")
  WHERE "status" IN ('PENDING_APPROVAL', 'IN_TRANSIT');

ALTER TABLE "transfers" ADD CONSTRAINT "transfer_from_to_differ" CHECK ("fromLocationId" <> "toLocationId");

-- ── Audit log is append-only ──
CREATE OR REPLACE FUNCTION itam_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: the audit log cannot be modified or deleted' USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION itam_audit_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION itam_audit_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION itam_audit_append_only();

-- Movements are history too: never rewritten.
CREATE TRIGGER movements_no_update BEFORE UPDATE ON "asset_movements"
  FOR EACH ROW EXECUTE FUNCTION itam_audit_append_only();
CREATE TRIGGER movements_no_delete BEFORE DELETE ON "asset_movements"
  FOR EACH ROW EXECUTE FUNCTION itam_audit_append_only();

-- ── Search performance: trigram indexes for free-text search at 20k+ rows ──
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "assets_search_trgm" ON "assets" USING gin (
  (lower(coalesce("assetCode",'') || ' ' || coalesce("legacyTag",'') || ' ' || coalesce("serialNumber",'') || ' ' ||
         coalesce("hostname",'') || ' ' || coalesce("ipAddress",'') || ' ' || coalesce("make",'') || ' ' || coalesce("model",''))) gin_trgm_ops);
CREATE INDEX "employees_name_trgm" ON "employees" USING gin (lower("name") gin_trgm_ops);
