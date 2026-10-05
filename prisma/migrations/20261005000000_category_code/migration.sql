-- Short category code used by the configurable Asset ID format ({CAT} token, e.g. LAP).
-- Optional: existing categories keep working and fall back to a code derived from the name.
ALTER TABLE "asset_categories" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "asset_categories_code_key" ON "asset_categories"("code");
