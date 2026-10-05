# Testing

## Automated tests

```bash
npm test
```

Vitest runs against a **disposable database**: `TEST_DATABASE_URL`, or `DATABASE_URL` with `_test` appended to the database name. Global setup refuses any database whose name does not end in `_test`, then drops and recreates it and applies every migration. Your development data is never touched. Each test file builds its own small organisation with unique names (one region, two states, three branches, one user per role), so files do not interfere.

Tests call service functions and API route handlers directly with real sessions. Branch-user tests therefore prove the **server** refuses out-of-scope access, not that a button is hidden.

| File | What it proves | FRD references |
|---|---|---|
| `auth.test.ts` (8) | Passwords stored only as bcrypt hashes. Forwarding headers are trusted only behind a configured proxy, and then only the proxy-appended entry is used. Generic sign-in error. Lockout after the threshold. Idle timeout ends the session. Deactivation revokes sessions. Reset tokens are single-use and policy-checked. Changing a password needs the current one. | FR-CFG-09, NFR-04 |
| `scoping.test.ts` (7) | A branch user gets 404 for another branch's asset by id **and** by Asset ID, through service and API. Lists, reports and CSV exports contain only in-scope rows. Employees and dashboard are scoped. A branch cannot raise a transfer from, or receive one addressed to, another branch, and the denial is audited. The audit log is closed to branch users. No session gives 401. | TC-ACC-08/09/10, BR-TRF-2 |
| `assets.test.ts` (10) | Duplicate serials block, case-insensitively and against retired assets. Duplicate hostnames warn, need a reason, and flag both records. Server-side serial requirement. Branch users cannot create assets and can edit only network fields (denials audited). **Raw SQL** cannot change an Asset ID, delete an asset, or modify, delete or truncate the audit log or movement history. Partial updates never reset unsent fields. Audit retention cannot go below 7 years. | FR-REG-01/05, AC-01, TC-REG-03, FR-AUD-01 |
| `transfers-approvals.test.ts` (5) | IT-raised transfer goes straight to In transit and locks assets. Partial receipt with mandatory reject reason. Exception flag and resolution. Processed lines cannot be received twice. Branch-raised transfer needs IT approval, and the destination confirms receipt with the received-by name recorded. Rejection needs a comment and releases the assets. A matching policy holds an assignment, the requester cannot approve their own request, and another approver's decision executes it. Bulk check-in goes through the same policy. | FR-TRF-01..10, FR-APR-01..04, FR-ASG-03 |
| `verification-renewals.test.ts` (3) | Campaign snapshot excludes later assets. Mark, mark-all keeps overrides. Submit needs every line. Scope enforced. Sign-off blocked until findings are reviewed. Accepted findings apply (Missing flag, corrected hostname, new asset from an unlisted find). Renewal tiers fire once per cycle. A later run fires only the current tier. Renewing starts a new cycle. Acknowledging stops reminders. Branch users cannot act. | FR-VER-01..08, FR-REN-04..06 |
| `integrations-imports.test.ts` (7) | Bad API key gives 401, audited without the key, and only a hash is stored. Empty fields fill. A manually set field queues a conflict. Unknown devices are queued. Re-sending a batch is a no-op. Conflict resolution is IT-only. A manual edit of a source-owned field raises a conflict. A revoked key stops working. The import dry run writes nothing and the commit applies exactly the dry-run result. The commit refuses when the data changed. Row reports purge after retention while the log stays. Branch users cannot import. | FR-INT-02/03/05/08/09, FR-IMP-03/05/07/12 |
| `asset-id-labels-scan.test.ts` (9) | The default Asset ID format is unchanged. A new format applies to new assets only, existing IDs and edits are unaffected, and lookups work by the new ID. Bulk add issues unique IDs (including serial-required categories) and categories without a code fall back to a name-derived one. The running number moves forward only. Invalid formats and non-administrators are refused. Category codes are validated and unique. Scanner lookup by Asset ID, serial and bare number, with out-of-scope assets reported as not found. Thermal and A4 labels and the QR code are scoped. | FR-REG-01/10/11 |
| `reports.test.ts` (2) | The CSV export has exactly the rows and cells shown on screen. Dashboard totals reconcile with the asset list, for a branch user and for IT. | TC-RPT-01, FR-RPT-01 |

Latest run: **51 tests, all passing** (`npx vitest run`, about 13 s).

Static checks: `npm run typecheck`, `npm run lint`, `npm run build`.

## Performance (NFR-01/02)

`npm run perf:check` times the NFR-02 targets at the service layer against a database filled by `npm run db:generate-volume` (see [SETUP.md](SETUP.md)). It prints PASS or FAIL per target and exits non-zero on a miss.

Results in the development container (PostgreSQL 16, same host), with **60,154 assets**, three times the 20,000-asset design volume:

| Target (FRD) | Limit | Measured |
|---|---|---|
| Search by IP (TC-NFR-01) | 1 s | 430 ms |
| Search by hostname | 1 s | 289 ms |
| Filter by branch | 1 s | 13 ms |
| Filter by item (category) | 1 s | 15 ms |
| Free-text search | 1 s | 229 ms |
| Branch user's asset list | 1 s | 8 ms |
| Asset list first page / deep page (TC-NFR-02) | 1 s | 8 ms / 78 ms |
| Dashboard, IT / branch | 2 s | 179 ms / 219 ms |
| Submit a 100-line transfer (TC-NFR-03) | 3 s | 129 ms |
| Submit a 20,000-line transfer (TC-TRF-49) | 30 s | 11.8 s (measured at 40,154 assets) |
| Import 20,000 rows, dry run plus commit (TC-IMP-14) | 10 min | 44 s |

These measure the query and write paths without network or rendering time. Page loads add rendering, which the browser checks below exercised at demo scale.

## Concurrency (NFR-03, TC-NFR-04)

`npm run load:test -- --sessions 50 --seconds 60` signs in many real sessions over HTTP and runs them at once. Each session loops through the asset list, search, Asset ID lookup, dashboard and receiver inbox, and IT sessions also raise and receive transfers. Each session searches only its own scope. The app must run with `TRUST_PROXY_HOPS=1` so each virtual user has its own client IP. The script prints p50 and p95 per request type and fails on unexpected errors or a missed limit. It writes real transfers, so run it only on a development or staging copy.

Result in the development container: one production `next start` process on 4 CPUs, PostgreSQL on the same host, 20,137 assets, **50 sessions** (35 branch, 15 IT/Admin), 60 seconds:

| Request | Count | p50 | p95 | Limit (p95) |
|---|---|---|---|---|
| Asset list | 1,289 | 243 ms | 483 ms | 1 s |
| Search | 1,289 | 333 ms | 577 ms | 1 s |
| Lookup by Asset ID | 1,289 | 250 ms | 425 ms | 1 s |
| Dashboard | 1,289 | 1,034 ms | 1,470 ms | 2 s |
| Receiver inbox | 1,289 | 282 ms | 498 ms | 1 s |
| Transfer submit | 343 | 387 ms | 823 ms | 3 s |
| Receipt | 28 | 493 ms | 1,887 ms | 3 s |

That was 6,816 requests (about 114 per second) with **0 unexpected errors**. Most IT transfers (309) were held by the seeded approval policies, as designed. There were 9 expected refusals caused by the test's own contention. When two sessions picked the same asset at the same moment, the open-transfer lock correctly rejected the second with a clear 409/400. Twice, a branch looked up an asset that another session had just transferred away and got 404. These timings are end-to-end over HTTP and include JSON serialisation. Under load the dashboard is the heaviest page; the rest stay well inside their limits.

## Manual and browser checks

Every screen was opened in headless Chromium as an Administrator and as a branch user, with no JavaScript errors. Branch users see "Not available" on admin, audit, import and integration pages, and the API behind each returns 403.

## Adding tests

Use `world()` from `tests/fixtures.ts` for an isolated organisation, and `call()` / `sessionCookie()` from `tests/helpers.ts` to hit route handlers as a real signed-in user. Scope policies to a category created in the test so they cannot affect other files.
