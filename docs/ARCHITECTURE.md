# Architecture

## Overview

```
Browser ──► Next.js App Router ─┬─ pages  (src/app/(app)/…, React client components)
                                └─ API    (src/app/api/**/route.ts)
                                        │  route()/publicRoute() wrapper: session, role, CSRF, error mapping
                                        ▼
                                 Services (src/server/services/*.ts)
                                        │  every call takes an Actor; scope and permissions checked here
                                        ▼
                                 Prisma ──► PostgreSQL (constraints and triggers hold the invariants)

Worker (src/worker/main.ts) ── job queue (imports) · email outbox · daily schedules · integration schedules
```

- **One code path per rule.** Pages never talk to the database. Every read and write goes through a service function that receives the calling `Actor` and applies scope and permission rules itself. API routes are thin: they parse the request, call a service and serialise the result.
- **The database is the last line of defence.** Invariants that must hold even if application code is bypassed are enforced in PostgreSQL: immutable Asset IDs, no asset deletion, append-only audit and movement history, one open transfer line per asset, and holder/status consistency. See [DATABASE.md](DATABASE.md).
- **The worker** runs long or scheduled work: import validation and commit, the email outbox, daily jobs (renewal reminders, verification scheduling and reminders, transfer aging, document and import-report purges, housekeeping) and integration pull and directory-sync schedules. Daily jobs are claimed through a unique `scheduled_events` row, so several workers never double-run them.

### Source layout

| Path | Contents |
|---|---|
| `src/app/(app)/` | Signed-in screens: dashboard, assets, transfers, approvals, verification, renewals, reports, imports, employees, integrations, documents, audit, notifications, account, admin |
| `src/app/(auth)/` | Sign-in, password reset, invitation acceptance |
| `src/app/api/` | JSON API (see [API.md](API.md)) |
| `src/components/` | Shared UI: data table with URL-backed filters, forms, pickers, modals, documents panel |
| `src/server/services/` | Business logic, one module per area |
| `src/server/import/` | Parsing, templates and row validation for asset, employee and branch-user imports |
| `src/server/auth/` | Password hashing and policy, sessions, lockout, reset tokens |
| `src/server/scope.ts` | Location-scope helpers used by every service |
| `src/server/audit.ts` | Audit writer |
| `src/server/http.ts` | Route wrappers: authentication, role checks, CSRF check, error mapping |
| `src/worker/` | Background worker |
| `prisma/` | Schema, migrations, development seed |
| `scripts/` | Volume generator and performance check (development only) |
| `tests/` | Automated tests |

## Security model

### Authentication
- Passwords are hashed with bcrypt (cost 12 by default). The policy (minimum length, character classes, no part of the email address) is validated on the server.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure` under HTTPS. Only the SHA-256 of the token is stored. Idle timeout (30 minutes by default) and absolute lifetime (12 hours) are configurable. Deactivating a user revokes their sessions.
- After a configurable number of failed sign-ins (5 by default) the account locks for a period (15 minutes). Sign-in is also rate-limited per IP. The failure message is generic, so it does not reveal whether an email exists.
- Password reset and invitation tokens are single-use, time-limited and stored hashed.
- Every sign-in, sign-out, failure, lockout and timeout is audited.

### Authorisation and location scoping
- Roles: **Administrator** (everything, including configuration and users), **IT Operator** (all operational work across all locations), **Branch User** (own location subtree only).
- Each location stores its materialised `idPath` (`/<root>/<state>/<branch>/`). A branch user's scope is their location's `idPath`. `src/server/scope.ts` turns it into a Prisma filter (`locationScope`, `assetScope`, `employeeScope`, `transferScope`). The helpers fail closed: a branch user with no location matches nothing.
- **Every** service that reads or writes scoped data applies these filters: lists, detail, search, lookups, dashboards, reports, exports, documents, notifications, approvals and verification. An out-of-scope record returns **404**, never 403, so no field of it leaks.
- Role checks sit in both places. Route wrappers declare allowed roles, and services re-check them, so a new route cannot accidentally widen access. Denials of scoped actions are audited (`ACCESS_DENIED`).
- Hiding a button is never the control. The automated tests call services and API handlers directly as branch users to prove this ([TESTING.md](TESTING.md)).

### Other controls
- CSRF: cookie-authenticated mutations must come from the same origin (`Origin` header check) and cookies are `SameSite=Lax`.
- Integration API keys are shown once, stored as SHA-256 hashes, compared in constant time, rate-limited per source, and every failed attempt is audited. Pull tokens and LDAP bind passwords are AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- Uploads are checked against an allowed MIME list and size limit, optionally virus-scanned (ClamAV or an HTTP scanner), and images are downscaled. Files live outside the web root and are served only through a scoped, audited download route.
- Secrets never reach logs. The email worker logs recipient and subject only. Integration configuration is redacted in audit details. API keys and passwords are never returned after creation.
- Security headers: `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, a permissions policy, and HSTS when `FORCE_HTTPS=true`.

## Main workflows

**Asset lifecycle.** `IN_STOCK ⇄ ASSIGNED`, `→ UNDER_REPAIR →`, `→ RETIRED` (terminal). "In transit" is a transfer state, not an asset status. Each change writes an `asset_movements` row (append-only history) and an audit entry. Actions that match an approval policy create an approval request instead of executing. The request's final approval executes the stored action, re-checking its preconditions at that moment.

**Transfers.** Draft → (Pending approval) → In transit → Partially received → Completed, with Rejected, Cancelled and Recalled branches. While a line is open the asset is locked: it cannot be transferred again, assigned, repaired or retired. A unique partial index enforces this in the database. Receipt is per line. Received lines move the asset's location (and a location-type holder) to the destination. Not-received lines become exceptions that IT resolves as re-sent, located at sender, or written off.

**Approvals.** The first active policy (by priority) whose conditions all match applies. Steps with the same order number run in parallel and all must approve; higher numbers follow sequentially. Built-in rule when no transfer policy matches: branch-raised transfers need IT approval, IT-raised ones are auto-approved.

**Asset IDs, labels and scanning.** The Asset ID is issued on insert (manual create, bulk add, import, integration auto-create, verification finds) from the format set under Settings: a pattern of `{PREFIX}`, `{CAT}` (the category code, or the first letters of its name), `{YYYY}`/`{YY}` and the required `{SEQ}`. The default `{PREFIX}-{SEQ}` with prefix AST and 6 digits reproduces the original `AST-000001`. `{SEQ}` comes from one global sequence, so a number is never reused across categories, years or format changes, and a format change affects new assets only. The QR code on a label encodes only the Asset ID, so labels stay valid when details change. The scanner (Assets → Scan asset) reads labels with the camera (the browser's BarcodeDetector, or zxing-wasm served from `/zxing`) or a USB/Bluetooth scanner, resolves the code through the same scoped lookup as the header search, and links to the asset's actions. Out-of-scope assets look exactly like unknown codes.

**Verification.** A campaign creates one task per branch with a frozen snapshot of that branch's assets. Assets in an open transfer are excluded and shown as in transit. The branch marks every line and submits, which locks the task. IT reviews Missing and Wrong-details lines and unlisted finds, then signs off. Accepted findings are applied: a Missing flag, corrected hostname, IP or holder, or a new asset for an unlisted find.

**Renewals.** Each renewable has a cycle. The scheduler finds the tightest reminder tier the item has reached and delivers it once per cycle, guaranteed by a unique `(renewable, cycle, tier)` row. Marking renewed starts a new cycle.

**Imports.** Upload, then an asynchronous dry run stores a row report with no data changes. Confirm, and the commit re-validates against the current database. If any row's result changed, nothing is applied. Otherwise every row is applied in one transaction.

**Integrations.** Device records are matched by serial (then an optional secondary key). For each syncable field the source's rule applies. OVERWRITE always writes. WARN writes only if the field is empty or was last written by this source, otherwise it queues a conflict. IGNORE never writes. Unknown devices go to an unmatched queue, or are auto-created if the source allows it. Batches are idempotent by `batchId`, or by payload hash when no batch id is given.

## Decisions where the FRD was silent or ambiguous

The FRD was followed wherever it is specific. Where it was silent or ambiguous, the choices below were made. Each is small to change if the business prefers otherwise. Items marked **(confirm)** are worth a business decision before go-live.

**Duplicates and identity**
1. Serial numbers and legacy tags always **block** duplicates, including against retired assets. They are unique keys in the data model, so the settings screen offers warn/off only for hostname and IP.
2. Hostname and IP duplicate checks ignore retired assets.

**Approvals**
3. Cost conditions compare against the **highest single-asset** purchase cost among the affected assets, not the sum.
4. A bulk action creates **one** approval request covering all its assets. Bulk check-in and bulk reassign (offboarding) go through the same policies as single actions.
5. If an approver of type "manager of the holder" cannot be resolved (no holder, no manager, or the manager has no active account), the step falls back to Administrators.
6. Administrators may approve their own requests. No one else can (FR-TRF-03).
7. **(confirm)** Asset-create policies apply to manual create and bulk add. Imports, integration auto-create and verification unlisted finds do **not** go through asset-create policies. Imports are IT-only with a mandatory dry run and confirmation. Auto-create is an Administrator opt-in per source. Unlisted finds are already an IT review decision.

**Transfers**
8. Drafts do not lock assets. The lock starts at submission.
9. A recall that leaves no line resolved makes the transfer Cancelled rather than Completed.
10. A location-type holder at the sending branch moves with the asset on receipt. Employee and department holders are kept.
11. Writing off a transfer exception retires the asset with disposal "Lost". It goes through retirement approval policies, and the asset is checked in only when the write-off actually executes, so a rejected write-off leaves it untouched.
12. Aging reminders for in-transit transfers repeat weekly after the aging threshold.

**Verification and branch users**
13. Branch users cannot create assets directly. They report unlisted assets through a verification task, and IT decides.
14. Missing flags raised by accepted verification findings are cleared automatically when a later signed-off verification marks the asset Present.

**Renewals**
15. Acknowledging stops escalation and further reminders for the current cycle only. The next cycle re-arms everything.
16. When a reminder run is missed, the next run sends only the tier the item is now in, not every skipped tier.

**Integrations**
17. The default field rule for a new source is WARN, never last-write-wins (FR-INT-08).
18. A manual edit of a field last written by a source raises a WARN conflict so IT can decide which value wins.
19. More than 10 unmatched devices in one run alerts Administrators by email.
20. AD sync never checks in assets automatically when it deactivates an employee. It alerts IT to employees who still hold assets (FR-EMP-03).
21. The pull field map is written as *source field → our field*, supporting dotted paths into nested JSON.

**Email, documents and retention**
22. Without SMTP configured, development logs recipient and subject (never the body). Production marks the mail failed so it is visible in the outbox. Use Mailpit locally (`docker compose --profile dev up`).
23. Audit entries are never deleted by the application. The audit retention setting (minimum 7 years) documents the retention commitment. Physical archival beyond that is an operations task.
24. Import row reports and uploaded import files are purged after the configured months (12 by default). The import log entry with who, file name, counts and time is kept.
25. Deleted documents are soft-deleted and physically purged after the document retention period.
26. For branch users the document library lists the most recent 5,000 in-scope documents. Filters narrow it further.
