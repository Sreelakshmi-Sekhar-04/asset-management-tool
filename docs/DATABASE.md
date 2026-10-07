# Database

PostgreSQL 14 or later (developed on 16). The schema lives in `prisma/schema.prisma`, and every change ships as a migration in `prisma/migrations/`. Apply migrations with `npm run db:migrate` (`prisma migrate deploy`). That command only applies pending migrations and never drops data.

The `pg_trgm` extension is created by the constraints migration. The database user running migrations needs permission to create it, or a DBA can create it beforehand.

## Tables by area

| Area | Tables | Notes |
|---|---|---|
| Configuration | `settings`, `locations`, `departments`, `asset_categories`, `asset_code_counters` | Settings are key/JSON rows over code defaults. Locations form a tree with materialised `idPath` (ids) and `namePath` (names) used for scoping and display. |
| People and access | `users`, `sessions`, `auth_tokens`, `rate_limits`, `employees` | Sessions and reset/invite tokens store only SHA-256 hashes. Users are separate from employees; a user may link to an employee record. |
| Register | `assets`, `duplicate_flags`, `asset_assignments`, `asset_movements` | `asset_movements` is the append-only history of every location, holder and status change. `asset_assignments` holds the holder periods. |
| Transfer history | `transfers`, `transfer_lines`, `transfer_receipts`, `transfer_exceptions` (read-only history; transfers are now movements on the asset) | Lines snapshot asset identity at dispatch. Receipts record who received and when. |
| Approvals | `approval_policies`, `approval_steps`, `approval_requests`, `approval_tasks` | Requests store the action payload and a snapshot of the policy name. Tasks carry decisions and comments. |
| Renewals | `renewables`, `renewal_events`, `reminder_policies`, `renewal_reminders` | `renewal_reminders` is unique on (renewable, cycle, tier), which is the "fires once" guarantee. |
| Verification | `verification_campaigns`, `verification_tasks`, `verification_lines`, `verification_unlisted` | Lines hold a JSON snapshot of each asset at campaign creation. |
| Documents | `documents` | Metadata only. Bytes live in `STORAGE_DIR`. Soft-deleted, then purged after retention. |
| Imports and jobs | `import_jobs`, `import_rows`, `jobs`, `scheduled_events` | `jobs` is the worker queue. `scheduled_events` de-duplicates daily tasks across workers. |
| Integrations | `integration_sources`, `integration_mappings`, `integration_runs`, `integration_conflicts`, `integration_unmatched`, `asset_source_data` | API keys stored hashed. Pull and bind secrets are AES-256-GCM encrypted. |
| Messaging | `notifications`, `email_outbox`, `saved_filters` | Notifications are unique per (user, event key), so events never notify twice. |
| Audit | `audit_log` | Append-only: actor, role, time, IP, entity, action, before/after, details, affected locations. |

## Invariants enforced in the database

These hold even if application code is bypassed. They are in `20260930000001_constraints/migration.sql`.

| Rule | Mechanism |
|---|---|
| Asset ID is always system-assigned, in the configured format, unique and never reused | `assets_assign_code` trigger calls `itam_next_asset_code()` ([ASSET-IDS-AND-LABELS.md](ASSET-IDS-AND-LABELS.md)) |
| Asset ID can never change (AC-01, TC-REG-03) | `assets_guard_update` trigger raises `ASSET_ID_IMMUTABLE` |
| A retired asset cannot be moved, assigned or edited (remarks excepted) | same trigger raises `ASSET_RETIRED` |
| Assets are never deleted | `assets_no_delete` trigger |
| Transfer numbers never change | `transfers_guard_no` trigger |
| Audit log is append-only: no UPDATE, DELETE or TRUNCATE | `audit_log_no_update`, `_no_delete`, `_no_truncate` triggers |
| Movement history is append-only | `movements_no_update`, `movements_no_delete` triggers |
| An asset is on at most one open transfer line (BR-TRF-1) | partial unique index `transfer_lines_one_open_per_asset` on lines Pending approval or In transit |
| Serial and legacy tag unique, case- and space-insensitive | normalising trigger fills `serialNormalized` / `legacyTagNormalized`, which have unique indexes |
| Assigned ⇒ has holder; holder ⇒ Assigned or Under repair; Retired ⇒ no holder; not Retired ⇒ has location | `inv1`–`inv3` and `location_required_unless_retired` CHECK constraints |
| Exactly one holder reference matching the holder type | `holder_reference_consistent` CHECK |
| Purchase cost is not negative; a transfer's from and to differ | CHECK constraints |

Application errors from these guards are translated into readable messages (`src/lib/errors.ts`).

## Indexes for volume

Besides the foreign-key and unique indexes, there are indexes on the columns lists filter and sort by (status, location, category, created date, audit time, entity) and trigram indexes for free-text search. At 60,000 assets every list and search target is met ([TESTING.md](TESTING.md)).

## Migrations

| Migration | Purpose |
|---|---|
| `20260930000000_init` | All tables, enums and indexes |
| `20260930000001_constraints` | Triggers, CHECK constraints, partial unique index, trigram search indexes |
| `20260930000002_verification_line_asset_fk` | Foreign key from verification lines to assets |
| `20260930000003_import_report_purge` | `import_jobs.reportPurgedAt` for the import-report retention purge |
| `20261005000000_asset_id_format` | Category `code`, `asset_code_counters`, configurable Asset ID trigger. Existing Asset IDs are not changed. |

To add one during development: edit `schema.prisma`, then run `npm run db:migrate:dev -- --name <what_changed>` and commit the new folder.

## Backups and retention

- Back up both the database (`pg_dump -Fc`) and the `STORAGE_DIR` volume. The Compose stack includes a nightly database dump kept for 14 days ([DEPLOYMENT.md](DEPLOYMENT.md)).
- The audit log is never deleted by the application. The configured audit retention (7 years minimum) is a commitment, not a purge.
- Deleted documents are purged after the document retention period (7 years by default). Import row reports and files are purged after the import retention period (12 months by default), while the import log entry stays.

## Migrations added for the organization context

| Migration | What it does |
|---|---|
| `20261006000000_org_enum_values` | Adds `LocationType.ORGANIZATION` and `MovementKind.TRANSFERRED`. It is a migration of its own because PostgreSQL refuses to use a new enum value in the transaction that created it. |
| `20261006000001_org_context_register_transfer` | Adds `departments.organizationId`, turns every root location into an `ORGANIZATION`, attaches existing departments to the only organization when there is exactly one, and closes transfers, transfer lines and transfer approval requests that were still open, since transfers are now made from the asset register. Completed transfers, receipts, exceptions and all movements are untouched. |

Both are written so they can be re-applied to a database that already has part of them (`ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, conditional constraint creation, idempotent `UPDATE`s), which is what the repair procedure above needs.

On Windows PowerShell:

```powershell
npm run db:migrate
npx prisma generate
npm run db:reset-demo -- --yes   # optional: replace all data with the small demo set
```

### `20261006000002_joy_alukkas_headquarter`

Makes Joy Alukkas the head quarter. A database whose top-level locations were regions (North, South, West from the original seed) had those regions shown as organizations; this migration creates the Joy Alukkas organization (or reuses one of that name), moves every other top-level location beneath it as a region, prefixes the location paths, attaches every department to it, and renames the application from the demo default "Demo Organisation Pvt Ltd" to Joy Alukkas. Ids, Asset IDs and history are unchanged. An empty database is left alone (the seed creates the organization), and running it again changes nothing.
