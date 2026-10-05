# Phase 1 checklist and Phase 2 safety check

## Phase 1 requirement coverage

Scope: cuts **A**, **B** and **R1** of the FRD, §A4. Every Phase 1 functional requirement is listed, with the code that implements it. Requirements tagged in code comments were located by their ID; the rest were traced by hand. Behaviour covered by automated tests is described in [TESTING.md](TESTING.md). Decisions taken where the FRD was silent are in [ARCHITECTURE.md](ARCHITECTURE.md#decisions-where-the-frd-was-silent-or-ambiguous).

Summary: **114 of 114** Phase 1 requirements implemented. FR-VER-11 (a 10-day-cut stretch version of verification) is superseded by the full verification module.

| ID | Requirement (first sentence) | Cut | Status | Where |
|---|---|---|---|---|
| FR-CFG-01 | Maintain organisation name and logo. | R1 | Done | src/server/services/master.ts |
| FR-CFG-02 | Maintain asset categories (add, rename, deactivate) with per-category flags: | A | Done | src/server/services/master.ts |
| FR-CFG-03 | Maintain the location hierarchy Region → Branch, to unlimited depth. | A | Done | src/server/services/locations.ts; Admin → Locations |
| FR-CFG-04 | Maintain departments. | A | Done | src/server/services/master.ts |
| FR-CFG-05 | User management: | A create · B bulk | Done | src/server/import/employees.ts |
| FR-CFG-06 | Duplicate-rule configuration. | A | Done | src/server/services/assets.ts |
| FR-CFG-07 | Approval-policy and reminder-policy configuration (§A4.9, §A4.8). | R1 | Done | src/server/services/approvals.ts |
| FR-CFG-08 | Transfer-aging threshold — days in transit before an alert; default 7. | B | Done | src/server/services/aging.ts |
| FR-CFG-09 | Login: | A | Done | src/server/auth/password.ts; src/server/auth/session.ts |
| FR-EMP-01 | Employee record: | A | Done | src/server/services/employees.ts; Employees screen |
| FR-EMP-02 | Bulk import of employees from CSV or Excel with a validation report, using the same rules as §A4.4. | A | Done | src/server/import/employees.ts; Imports (type Employees) |
| FR-EMP-03 | Offboarding view: | B | Done | src/server/services/employees.ts; src/server/services/integrations.ts; src/server/services/lifecycle.ts |
| FR-EMP-04 | AD sync (§A4.11) may create and update employees and manager links. | R1 | Done | src/server/services/integrations.ts |
| FR-REG-01 | Create an asset manually. | A | Done | src/server/services/assets.ts |
| FR-REG-02 | View an asset: | A | Done | src/server/services/history.ts |
| FR-REG-03 | Edit an asset according to the editability matrix (§A4.3.3). | A | Done | src/server/services/assets.ts |
| FR-REG-04 | Retire an asset — never delete. | A | Done | src/server/services/lifecycle.ts |
| FR-REG-05 | Duplicate detection on create, edit and import, per FR-CFG-06. | A | Done | src/server/services/assets.ts; prisma/schema.prisma; src/components/asset-form.tsx |
| FR-REG-06 | Renaming a hostname or changing an IP updates the same record; it never creates a new asset. | A | Done | src/server/services/assets.ts `updateAsset` edits in place; code immutable by trigger |
| FR-REG-07 | Search and filter: | A | Done | src/server/services/assets.ts |
| FR-REG-08 | Bulk-add by model × quantity: | R1 | Done | src/server/services/assets.ts |
| FR-REG-09 | Scanner-friendly entry: | R1 | Done | src/components/scanner.ts |
| FR-REG-10 | Label generation: | R1 | Done | src/server/pdf.ts, src/components/labels.tsx |
| FR-REG-11 | Asset lookup by scanning or typing the Asset ID from any screen, through a global search box. | A | Done | src/server/services/assets.ts, src/app/(app)/scan |
| FR-IMP-01 | Download import templates for assets and employees, in CSV and Excel, with column help. | A | Done | src/server/import/templates.ts; `/api/imports/template` |
| FR-IMP-02 | Upload a CSV or Excel file of up to 20,000 rows. | A | Done | src/server/import/engine.ts + worker job queue; imports/[id] progress page |
| FR-IMP-03 | Dry-run first: | A | Done | src/server/import/engine.ts |
| FR-IMP-04 | Row-level validation: | A | Done | src/server/import/assets.ts `validateAssets` (incl. in-file duplicates) |
| FR-IMP-05 | Result report, downloadable as CSV: | A | Done | src/server/import/engine.ts |
| FR-IMP-06 | The location column accepts a path such as Region/Branch; unknown nodes may be auto-created if the user ticks "create… | A | Done | src/server/import/assets.ts + locations `resolveLocationPath`; "create missing locations" option |
| FR-IMP-07 | Modes: | A | Done | src/server/import/assets.ts |
| FR-IMP-08 | Idempotent and re-runnable: | A | Done | src/server/import/assets.ts |
| FR-IMP-09 | Imported holder columns (employee ID) create assignments as the initial state, recorded in history as "Imported". | A | Done | src/server/import/assets.ts `applyAssets` (IMPORTED + ASSIGNED movements) |
| FR-IMP-10 | Import the legacy tag into the Legacy tag field, and retain the original row number in the report. | A | Done | src/server/import/templates.ts (Legacy Tag column); row numbers in `import_rows` |
| FR-IMP-11 | Export any list view or report to CSV or Excel. | A | Done | src/server/export.ts |
| FR-IMP-12 | Every import is logged — who, file name, counts, timestamp — and remains downloadable for 12 months. | R1 | Done | `import_jobs` log; `purgeExpiredImportReports` (engine.ts); tested |
| FR-ASG-01 | Assign an asset that is In stock and free of open transfers to an employee, department or location. | A | Done | src/server/services/lifecycle.ts |
| FR-ASG-02 | Check-in: | A | Done | src/server/services/lifecycle.ts |
| FR-ASG-03 | Assign and check-in may be gated by an approval policy (§A4.9). | R1 | Done | src/server/services/lifecycle.ts `gate()`; tested |
| FR-ASG-04 | Each asset shows its assignment history. | A | Done | src/server/services/movement.ts |
| FR-ASG-05 | Assigning within the same branch is a one-step action; no receipt is involved. | A | Done | src/server/services/lifecycle.ts `assignAsset` (no receipt step) |
| FR-TRF-01 | Create a transfer request with 1 to 20,000 line items. | A | Done | src/server/services/transfers.ts |
| FR-TRF-02 | Validation at submit: | A | Done | src/server/services/transfers.ts |
| FR-TRF-03 | Approval step. | A | Done | src/server/services/transfers.ts `submitInTx`; approvals.ts `decide`; tested |
| FR-TRF-04 | On approval the request becomes In transit and every line is In transit. | A | Done | src/server/services/transfers.ts |
| FR-TRF-05 | Receiver inbox: | A | Done | src/server/services/transfers.ts |
| FR-TRF-06 | Receipt per line: | A | Done | src/server/services/transfers.ts `receive`; transfers/[id] receive panel; receipt documents |
| FR-TRF-07 | On Received: | A | Done | src/server/services/transfers.ts `receive` (location, location-holder, movement with approver and receiver); tested |
| FR-TRF-08 | On Rejected or Not received: | A | Done | src/server/services/transfers.ts |
| FR-TRF-09 | Partial receipt: | A | Done | src/server/services/transfers.ts `recomputeHeader`; progress "N of M resolved"; tested |
| FR-TRF-10 | Exception resolution by IT: | B | Done | src/server/services/transfers.ts |
| FR-TRF-11 | Aging alert: | B | Done | src/server/services/aging.ts |
| FR-TRF-12 | Cancel and recall: | A | Done | src/server/services/transfers.ts |
| FR-TRF-13 | Printable transfer note (PDF): | B | Done | src/server/pdf.ts |
| FR-TRF-14 | Notifications: | A in-app · B email | Done | src/server/services/transfers.ts notifications; src/server/notify.ts (in-app + email outbox) |
| FR-TRF-15 | Late-recorded transfers: | B | Done | src/server/services/transfers.ts `createTransfer` (effectiveDate, recordedLate; branch users cannot back-date) |
| FR-TRF-16 | Transfers of under-repair assets preserve the repair status. | A | Done | src/server/services/transfers.ts `receive` keeps status (movement toStatus = status at dispatch) |
| FR-TRF-17 | Employee-to-employee and department moves within the same location are assignments (FR-ASG), not transfers. | A | Done | src/server/services/lifecycle.ts |
| FR-STA-01 | Asset statuses are In stock, Assigned, Under repair and Retired. | A | Done | prisma/schema.prisma `AssetStatus` (4 values; in transit is a transfer state) |
| FR-STA-02 | Allowed changes: | A | Done | src/server/services/lifecycle.ts; prisma/schema.prisma |
| FR-STA-03 | Bulk status change with select-across-pages. | R1 | Done | src/server/services/lifecycle.ts |
| FR-STA-04 | Repair and retirement may be approval-gated (§A4.9). | R1 | Done | src/server/services/lifecycle.ts `gate()` for repair and retire |
| FR-STA-05 | A reason is mandatory for repair and retirement; retirement also records the disposal type — scrapped, sold, donated… | A | Done | src/server/services/lifecycle.ts |
| FR-REN-01 | One generic renewable record attachable to any asset: | R1 | Done | src/server/services/renewables.ts; src/components/renewable-form.tsx |
| FR-REN-02 | Software licences may be tracked without a device by attaching them to an asset of category Software. | R1 | Done | asset_categories.isSoftware; renewables attach to any asset |
| FR-REN-03 | Entering a warranty end on an asset creates or updates its warranty renewable automatically. | R1 | Done | src/server/services/renewables.ts |
| FR-REN-04 | Reminder policy: | R1 | Done | src/server/services/renewables.ts |
| FR-REN-05 | Actions: | R1 | Done | src/server/services/renewables.ts |
| FR-REN-06 | Escalation: | R1 | Done | src/server/services/renewables.ts |
| FR-REN-07 | Renewables list with filters — type, branch, expiring within N days, status — and export. | R1 | Done | src/server/services/renewables.ts |
| FR-REN-08 | Expiry dates supplied by integrations (§A4.11) create or update renewables carrying a source flag. | R1 | Done | src/server/services/renewables.ts |
| FR-APR-01 | Configurable approval policies gate these action types: | R1 | Done | src/server/services/approval-handlers.ts; src/server/services/approvals.ts |
| FR-APR-02 | A policy matches on conditions: | R1 | Done | src/server/services/approvals.ts |
| FR-APR-03 | Each policy has one or more steps, sequential or parallel. | R1 | Done | src/server/services/approvals.ts (steps by order; equal order = parallel; USER / ROLE / HOLDER_MANAGER) |
| FR-APR-04 | Approver actions: | R1 | Done | src/server/services/approvals.ts |
| FR-APR-05 | Pending-approvals inbox with counts, filters and bulk approve. | A transfers · R1 all | Done | src/server/services/approvals.ts |
| FR-APR-06 | Every request, decision, approver, timestamp and comment is audited. | A | Done | src/server/services/approvals.ts audit on request, decision, reassign, cancel |
| FR-APR-07 | 10-day cut simplification: | A | Done | src/server/services/approvals.ts |
| FR-VER-01 | IT creates a campaign: | B | Done | src/server/services/verification.ts |
| FR-VER-02 | The branch user sees a checklist and marks each asset Present, Missing or Wrong details (supplying corrected hostname… | B | Done | src/server/services/verification.ts |
| FR-VER-03 | Bulk "mark all present" with per-row override. | B | Done | src/server/services/verification.ts |
| FR-VER-04 | The branch submits the task. | B | Done | src/server/services/verification.ts `submitTask` + `assertEditable` |
| FR-VER-05 | IT reviews discrepancies — missing, wrong details, unlisted — and accepts or rejects each. | B | Done | src/server/services/verification.ts; src/app/(app)/verification/discrepancies/page.tsx |
| FR-VER-06 | Assets in an open transfer are excluded from the checklist and shown as "in transit". | B | Done | src/server/services/verification.ts snapshot `inTransit` flag; excluded from marking |
| FR-VER-07 | Recurring campaigns, quarterly by default, auto-create tasks and remind branches that have not submitted — for exampl… | B | Done | src/server/services/verification.ts |
| FR-VER-08 | Completion dashboard: | B | Done | src/server/services/verification.ts |
| FR-VER-09 | Per-branch verified-stock export with the last-verified date and sign-off details. | B | Done | src/server/services/verification.ts `verifiedStock`; export on task page |
| FR-VER-10 | The initial baseline verification immediately after the Excel load is the first campaign. | B | Done | Any campaign after the initial import serves as the baseline; no special case needed |
| FR-VER-11 | Stretch for the 10-day cut: | A stretch | Superseded | Superseded by the full verification module (FR-VER-01..09) |
| FR-INT-01 | Scheduled and on-demand sync of employees — ID, name, email, department, manager, active flag — from Active Directory. | R1 | Done | src/server/services/integrations.ts |
| FR-INT-02 | A vendor-neutral inbound API and webhook accepts batches of device records from any source system. | R1 | Done | src/server/services/integrations.ts; src/app/api/integrations/[source]/devices/route.ts |
| FR-INT-03 | Authentication: | R1 | Done | src/server/crypto.ts; src/server/services/integrations.ts |
| FR-INT-04 | Optional pull: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-05 | Match rule: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-06 | Accepted fields, mapped per source: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-07 | The warranty and expiry feed creates or updates renewables, so reminders work without manual entry. | R1 | Done | src/server/services/renewables.ts |
| FR-INT-08 | Field ownership: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-09 | Idempotency: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-10 | Scope guard: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-11 | Integration health page, per source: | R1 | Done | src/server/services/integrations.ts |
| FR-INT-12 | ServiceDesk Plus reference: | R1 | Done | `sdpTicketId` / `sdpTicketUrl` on assets and transfers (link only) |
| FR-DOC-01 | Attach files — PDF, images, Office documents — to an asset, transfer, renewable, verification task or, in Phase 2, a… | R1 | Done | src/server/services/documents.ts; DocumentsPanel on asset, transfer, receipt, renewable, verification task |
| FR-DOC-02 | Limits: | R1 | Done | src/server/services/documents.ts; src/server/virus-scan.ts |
| FR-DOC-03 | Photos are optional everywhere (D9) and never a mandatory step. | R1 | Done | No workflow requires a photo; uploads are optional everywhere |
| FR-DOC-04 | Downloads and deletions are audited. | R1 | Done | src/server/services/documents.ts |
| FR-DOC-05 | Users see documents only for records within their scope. | R1 | Done | src/server/services/documents.ts |
| FR-AUD-01 | An immutable audit log of: | A | Done | src/server/audit.ts; audit calls in every service; append-only triggers; tested |
| FR-AUD-02 | The audit log is searchable by entity, actor, action and date range, and exportable. | A view · R1 export | Done | src/server/services/audit-query.ts |
| FR-AUD-03 | As-of-date view: | B | Done | src/server/services/history.ts |
| FR-AUD-04 | The asset timeline (FR-REG-02) is the user-friendly view of the same history. | A | Done | src/server/services/history.ts |
| FR-RPT-01 | Dashboard: | A basic · R1 full | Done | src/server/services/dashboard.ts |
| FR-RPT-02 | Standard reports, on screen and as CSV or Excel: | A first five · B · R1 | Done | src/server/services/reports.ts |
| FR-RPT-03 | Saved filters and "export current view". | R1 | Done | src/server/services/notifications.ts; src/components/list.tsx |
| FR-RPT-04 | Search by branch, system name, item, IP, name or serial returns results in under one second at design volume. | A | Done | src/server/services/assets.ts `assetWhere`; perf check 13–430 ms at 60k assets |

### Non-functional requirements

| ID | Status | Evidence |
|---|---|---|
| NFR-01 Volume | Met | Tested with 60,154 assets and 20,000-line transfers and imports |
| NFR-02 Performance | Met (service layer) | [TESTING.md](TESTING.md#performance-nfr-0102): every target passes with margin |
| NFR-03 Concurrency | Met | 50 concurrent sessions over HTTP, 60 s, 0 unexpected errors, every p95 within NFR-02 ([TESTING.md](TESTING.md#concurrency-nfr-03-tc-nfr-04)). Repeat on the target environment before go-live. |
| NFR-04 Security | Met | Server-side scoping on every read and write (tests), password policy, lockout, TLS support, secrets never logged, API keys hashed |
| Audit retention ≥ 7 years | Met | Audit log append-only by trigger; the setting cannot go below 7 |

### Items for business confirmation

These are implemented with a reasonable default and flagged rather than assumed. Details are in ARCHITECTURE.md.

1. Imports, integration auto-create and verification unlisted finds do not pass through asset-create approval policies (decision 7).
2. Administrators may approve their own requests (decision 6, from FR-TRF-03).
3. Cost-based policies compare the highest single-asset cost, not the total (decision 3).

## Phase 2 safety check

Phase 2 (procurement, sourcing, vendors, quotations, comparison, PO write-back, AI extraction; FR-SRC, FR-QTE, FR-CMP, FR-CLS) is **not implemented, designed, mocked, stubbed or exposed**.

Search run over `src/`, `prisma/`, `scripts/` and `tests/` (`.ts`, `.tsx`, `.prisma`, `.sql`), case-insensitive:

| Pattern | Matches |
|---|---|
| `procure`, `sourcing`, `quotation`, `quote`, `rfq` | 0 |
| `purchase order`, `\bPO\b`, `write-back` | 0 |
| `llm`, `openai`, `anthropic`, `extraction`, `\bai\b` | 0 |
| `FR-SRC`, `FR-QTE`, `FR-CMP`, `FR-CLS` | 0 |
| `phase 2` | 0 |
| `comparison` | 1, a code comment on constant-time hash comparison (security, unrelated) |

Also checked:

- **Database.** No vendor, quotation, sourcing-request, purchase-order or comparison tables or enums. `vendor` exists only as the free-text supplier name on an asset and a renewable, which are Phase 1 fields (§A4.3.1, FR-REN-01).
- **API and UI.** No routes, menu items, pages or feature flags for Phase 2. The document module's entity types are asset, transfer, transfer receipt, renewable, verification task and organisation only.
- **Integrations.** The SDP field is a link only (FR-INT-12). No Phase 2 write-back or sourcing hooks.

To repeat the check:

```bash
grep -rniE "procure|sourcing|quotation|quote|rfq|purchase.?order|\bPO\b|write-?back|\bllm\b|openai|anthropic|extraction|\bai\b|FR-(SRC|QTE|CMP|CLS)|phase ?2" \
  src prisma scripts tests --include=*.ts --include=*.tsx --include=*.prisma --include=*.sql
```
