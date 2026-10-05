-- Configurable Asset ID format. The Asset ID stays system-generated, unique, immutable and
-- never reused; only the text around the number is configurable. Existing Asset IDs are
-- never touched. With no configuration saved, new IDs keep the AST-000001 format.

-- Short category code, optionally placed in the Asset ID (e.g. IT-LAP-000123).
ALTER TABLE "asset_categories" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "asset_categories_code_key" ON "asset_categories"("code");

-- One running number per ID prefix, used when numbering is "separate per prefix".
CREATE TABLE "asset_code_counters" (
    "prefix" TEXT NOT NULL,
    "nextValue" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_code_counters_pkey" PRIMARY KEY ("prefix")
);

-- Highest number already used after a given prefix (so a new counter never collides).
CREATE OR REPLACE FUNCTION itam_max_asset_code_number(p_head text) RETURNS bigint AS $$
  SELECT coalesce(max(substr("assetCode", length(p_head) + 1)::bigint), 0)
  FROM "assets"
  WHERE left("assetCode", length(p_head)) = p_head
    AND substr("assetCode", length(p_head) + 1) ~ '^[0-9]{1,18}$';
$$ LANGUAGE sql STABLE;

-- Builds the next Asset ID from the saved configuration (Setting key "assetIdFormat").
CREATE OR REPLACE FUNCTION itam_next_asset_code(p_category_id text) RETURNS text AS $$
DECLARE
  cfg jsonb;
  v_prefix text; v_sep text; v_digits int; v_mode text; v_start bigint; v_cat text;
  v_head text; v_n bigint; v_code text; v_tries int := 0;
BEGIN
  SELECT "value" INTO cfg FROM "Setting" WHERE "key" = 'assetIdFormat';
  cfg := coalesce(cfg, '{}'::jsonb);
  v_prefix := coalesce(cfg->>'prefix', 'AST');
  v_sep := coalesce(cfg->>'separator', '-');
  v_digits := coalesce((cfg->>'digits')::int, 6);
  v_mode := coalesce(cfg->>'numbering', 'GLOBAL');
  v_start := greatest(coalesce((cfg->>'startNumber')::bigint, 1), 1);
  IF coalesce((cfg->>'includeCategoryCode')::boolean, false) THEN
    SELECT "code" INTO v_cat FROM "asset_categories" WHERE "id" = p_category_id;
  END IF;
  v_head := v_prefix || v_sep || CASE WHEN coalesce(v_cat, '') <> '' THEN v_cat || v_sep ELSE '' END;

  LOOP
    IF v_mode = 'PER_PREFIX' THEN
      IF NOT EXISTS (SELECT 1 FROM "asset_code_counters" WHERE "prefix" = v_head) THEN
        INSERT INTO "asset_code_counters" ("prefix", "nextValue")
        VALUES (v_head, greatest(v_start, itam_max_asset_code_number(v_head) + 1))
        ON CONFLICT ("prefix") DO NOTHING;
      END IF;
      -- The row lock serialises concurrent inserts on the same prefix.
      UPDATE "asset_code_counters" SET "nextValue" = "nextValue" + 1, "updatedAt" = now()
      WHERE "prefix" = v_head RETURNING "nextValue" - 1 INTO v_n;
    ELSE
      v_n := nextval('asset_code_seq');
    END IF;
    v_code := v_head || CASE WHEN length(v_n::text) >= v_digits THEN v_n::text ELSE lpad(v_n::text, v_digits, '0') END;
    -- A number is skipped (never reused) if an ID with the same text already exists,
    -- e.g. after switching between shared and per-prefix numbering.
    EXIT WHEN NOT EXISTS (SELECT 1 FROM "assets" WHERE "assetCode" = v_code);
    v_tries := v_tries + 1;
    IF v_tries > 10000 THEN
      RAISE EXCEPTION 'ASSET_ID_EXHAUSTED: could not find a free Asset ID after prefix %', v_head USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN v_code;
END $$ LANGUAGE plpgsql;

-- The Asset ID is always assigned by the database, whatever the caller sends.
CREATE OR REPLACE FUNCTION itam_assign_asset_code() RETURNS trigger AS $$
BEGIN
  NEW."assetCode" := itam_next_asset_code(NEW."categoryId");
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assets_assign_code BEFORE INSERT ON "assets"
  FOR EACH ROW EXECUTE FUNCTION itam_assign_asset_code();

-- The trigger now assigns the ID; the old column default would only burn sequence numbers.
ALTER TABLE "assets" ALTER COLUMN "assetCode" SET DEFAULT '';
