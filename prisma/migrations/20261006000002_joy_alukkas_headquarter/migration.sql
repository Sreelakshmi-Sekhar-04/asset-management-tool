-- Joy Alukkas as the head quarter.
--
-- Until now every top-level location was taken to be an organization, so a database seeded with
-- regions at the top (North, South, West) showed those regions as organizations. This makes
-- Joy Alukkas the organization and moves every other top-level location beneath it as a region,
-- keeping every id, Asset ID and history row; only the location paths gain the new top level.
--
-- An empty database (a fresh install) is left alone: the seed, or Configuration → Organizations,
-- creates the first organization. Safe to run again: it does nothing once Joy Alukkas is the
-- only top-level location.
DO $$
DECLARE
  joy  text;
  root record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "locations") THEN
    RETURN;
  END IF;

  SELECT "id" INTO joy FROM "locations" WHERE "parentId" IS NULL AND lower("name") = 'joy alukkas' LIMIT 1;
  IF joy IS NULL THEN
    joy := gen_random_uuid()::text;
    INSERT INTO "locations" ("id", "name", "type", "active", "parentId", "idPath", "namePath", "depth", "createdAt", "updatedAt")
    VALUES (joy, 'Joy Alukkas', 'ORGANIZATION', true, NULL, '/' || joy || '/', 'Joy Alukkas', 0, now(), now());
  ELSE
    UPDATE "locations" SET "type" = 'ORGANIZATION', "active" = true, "updatedAt" = now() WHERE "id" = joy;
  END IF;

  -- Every other top-level location, and everything beneath it, moves one level down.
  FOR root IN SELECT "id", "idPath" FROM "locations" WHERE "parentId" IS NULL AND "id" <> joy LOOP
    UPDATE "locations"
       SET "idPath"   = '/' || joy || "idPath",
           "namePath" = 'Joy Alukkas / ' || "namePath",
           "depth"    = "depth" + 1,
           "updatedAt" = now()
     WHERE "idPath" LIKE root."idPath" || '%';
    UPDATE "locations"
       SET "parentId" = joy,
           "type" = CASE WHEN "type" = 'ORGANIZATION' THEN 'REGION'::"LocationType" ELSE "type" END
     WHERE "id" = root."id";
  END LOOP;

  -- With a single organization, every department belongs to it.
  UPDATE "departments" SET "organizationId" = joy WHERE "organizationId" IS DISTINCT FROM joy;

  -- The application name shown in the sidebar and on sign-in, if it is still the demo default.
  UPDATE "Setting" SET "value" = '"Joy Alukkas"'::jsonb, "updatedAt" = now()
   WHERE "key" = 'orgName' AND "value" = '"Demo Organisation Pvt Ltd"'::jsonb;
END $$;
