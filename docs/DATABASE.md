# Database

PostgreSQL 14 or later (developed on 16). The schema lives in `prisma/schema.prisma`, and every change ships as a migration in `prisma/migrations/`. Apply migrations with `npm run db:migrate` (`prisma migrate deploy`). That command only applies pending migrations and never drops data.

The `pg_trgm` extension is created by the constraints migration. The database user running migrations needs permission to create it, or a DBA can create it beforehand.

## Tables by area

| Area | Tables | Notes |
|---|---|---|
| Configuration | `settings`, `locations`, `departments`, `asset_categories` | Settings are key/JSON rows over code defaults. Locations form a tree with materialised `idPath` (ids) and `namePath` (names) used for scoping and display. |
| People and access | `users`, `sessions`, `auth_tokens`, `rate_limits`, `employees` | Sessions and reset/invite tokens store only SHA-256 hashes. Users are separate from employees; a user may link to an employee record. |
| Register | `assets`, `duplicate_flags`, `asset_assignments`, `asset_movements` | `asset_movements` is the append-only history of every location, holder and status change. `asset_assignments` holds the holder periods. |
| Transfers | `transfers`, `transfer_lines`, `transfer_receipts`, `transfer_exceptions` | Lines snapshot asset identity at dispatch. Receipts record who received and when. |
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
| Asset ID can never change (AC-01, TC-REG-03) | `assets_guard_update` trigger raises `ASSET_ID_IMMUTABLE` |
| Asset ID running numbers are never reused | All Asset IDs draw from `asset_code_seq`, whatever the configured format; the next number can only be moved forward (`setval`) |
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
| `20261005000000_category_code` | Optional unique `asset_categories.code` for the `{CAT}` part of the Asset ID format |

To add one during development: edit `schema.prisma`, then run `npm run db:migrate:dev -- --name <what_changed>` and commit the new folder.

## Backups and retention

- Back up both the database (`pg_dump -Fc`) and the `STORAGE_DIR` volume. The Compose stack includes a nightly database dump kept for 14 days ([DEPLOYMENT.md](DEPLOYMENT.md)).
- The audit log is never deleted by the application. The configured audit retention (7 years minimum) is a commitment, not a purge.
- Deleted documents are purged after the document retention period (7 years by default). Import row reports and files are purged after the import retention period (12 months by default), while the import log entry stays.
