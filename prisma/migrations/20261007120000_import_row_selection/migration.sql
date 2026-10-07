-- Excel Upload preview: choose which rows to import, and remove rows from the batch.
--
--   • import_rows."selected": the row is ticked in the preview; only ticked, valid rows are imported.
--   • import_rows."removed":  the row was removed from this import batch in the preview. It is kept
--     (so the batch history stays complete) but is no longer checked, counted or imported.
--     Removing a row never touches an asset, a location or a department.
--
-- Additive only, and safe to run again on a partly migrated database.
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "selected" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "removed" BOOLEAN NOT NULL DEFAULT false;
