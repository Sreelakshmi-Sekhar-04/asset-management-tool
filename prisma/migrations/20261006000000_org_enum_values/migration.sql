-- Organization context, and transfer handled from the asset register.
--
-- Every statement is written so the migration can be applied to a database that already
-- has part of it (a repair re-run), as described in docs/DATABASE.md.

-- ── New enum values ──────────────────────────────────────────────────────────
-- ORGANIZATION: the root of the location tree is the organization / head quarter.
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'ORGANIZATION';
-- TRANSFERRED: a move to another location made straight from the asset register.
ALTER TYPE "MovementKind" ADD VALUE IF NOT EXISTS 'TRANSFERRED';
