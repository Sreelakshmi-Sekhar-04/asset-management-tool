# API

All endpoints live under `/api` and speak JSON unless noted. The web UI uses the same API, so there are no private back doors.

## Conventions

- **Authentication.** Browser sessions use the `itam_session` cookie set by `POST /api/auth/login`. Integration device pushes use `Authorization: Bearer <api key>` (see below). Nothing else is accepted.
- **Scope.** Every response is filtered to the caller's location scope. A record outside it answers **404**, not 403, so no field of it leaks.
- **CSRF.** Mutating requests from a browser must be same-origin (the `Origin` header is checked).
- **Paging.** List endpoints take `page` (from 1), `pageSize` (1–500, default 50), `sort` and `dir` (`asc` or `desc`) and return `{ "rows": [...], "total": n }`.
- **Filters.** Repeated keys mean "any of", for example `?status=IN_STOCK&status=ASSIGNED`.
- **Exports.** Report, list and audit endpoints accept `format=csv` or `format=xlsx` and return a file with exactly the rows the same query shows on screen. Every export is audited with its row count and filters.
- **Validation** happens on the server for every write. Client-side checks are only a convenience.

### Errors

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "serialNumber: Required for Laptop", "details": [{ "field": "serialNumber", "message": "Required for Laptop" }] } }
```

| Status | Typical codes | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Input failed validation. `details` lists fields or rows. |
| 401 | `UNAUTHENTICATED` (session), `UNAUTHORIZED` (API key) | No valid session or API key |
| 403 | `FORBIDDEN` | Role not allowed, or a cross-origin request |
| 404 | `NOT_FOUND` | Missing **or outside your scope** |
| 409 | `CONFLICT`, `DUPLICATE_BLOCKED`, `DUPLICATE_WARNING` | State conflict or duplicate. `DUPLICATE_WARNING` can be retried with a `duplicateReason`. |
| 422 | `VIRUS_DETECTED` | Upload failed the virus scan |
| 429 | `RATE_LIMITED` | Sign-in or integration rate limit |
| 503 | `SCAN_UNAVAILABLE` | Virus scanner unavailable in fail-closed mode |

Unexpected errors return 500 with a generic message. Details go to the server log, never to the client.

### Approval-gated actions

Assign (which covers transfers to a location), check-in, repair, retire, bulk status change and asset create may be held by an approval policy. The action then returns

```json
{ "pendingApproval": { "id": "…", "requestNo": "APR-000123", "policy": "High-value transfers" } }
```

instead of the result, and nothing changes until the request is approved (`POST /api/approvals/:id/decide`).

## Integration device hook

```
POST /api/integrations/{sourceKey}/devices
Authorization: Bearer itam_XXXXXXXX_…        (issued once per source under Integrations → source → API key)
Content-Type: application/json

{ "batchId": "mdm-2026-09-30T10:00", "records": [
    { "serialNumber": "5CG1234XYZ", "hostname": "KL-LAP-07", "ipAddress": "10.10.1.25",
      "macAddress": "00:1A:2B:3C:4D:5E", "os": "Windows 11", "osVersion": "23H2",
      "lastSeen": "2026-09-30T09:58:00Z", "currentUser": "priya.n", "patchStatus": "Current",
      "warrantyEnd": "2027-04-14",
      "expiries": [{ "type": "LICENCE", "label": "Office 365", "expiry": "2027-03-31", "identifier": "XXXX" }],
      "timestamp": "2026-09-30T09:58:00Z" } ] }
```

- Up to 5,000 records per call and 20 MB. Per-source rate limit (60 calls per minute by default).
- Returns **202** with `{ runId, status, alreadyApplied, counts: { received, created, updated, unchanged, conflicts, rejected, unmatched }, errors }`.
- **Idempotent.** Re-sending a `batchId` (or, without one, an identical payload already applied) changes nothing and returns `status: "DUPLICATE"`.
- Records are matched by serial number, then by the source's optional secondary key (hostname, MAC or legacy tag). Field rules (overwrite, warn or ignore) decide what is written. Unknown devices go to the unmatched queue unless the source auto-creates. A source-specific field map can rename incoming fields (`"device.name": "hostname"`).
- Records older than the last applied `timestamp` for the same asset are ignored.
- Failed authentication is audited with the key prefix only, never the key.

Pull sources call a configured URL with a stored bearer token on a schedule and feed the same pipeline. Directory sources (AD/LDAP) sync employees.

## ServiceDesk Plus reference

Assets carry optional `sdpTicketId` and `sdpTicketUrl` fields (FR-INT-12). They are links only. No call is made to ServiceDesk Plus.

## Health

`GET /api/health` returns `{"status":"ok"}` when the database answers, otherwise 503. It needs no authentication and reveals nothing else.

## Route list

"Route guard" is the role check in the route wrapper. Services apply further role and **location-scope** checks on every call, so "any signed-in" never means unscoped.

| Method | Path | Route guard |
|---|---|---|
| `GET` | `/api/health` | public |
| `POST` | `/api/admin/emails/:id/retry` | ADMIN |
| `GET` | `/api/admin/emails` | ADMIN |
| `PUT` | `/api/approval-policies/:id` | ADMIN |
| `DELETE` | `/api/approval-policies/:id` | ADMIN |
| `GET` | `/api/approval-policies` | ADMIN, IT_OPERATOR |
| `POST` | `/api/approval-policies` | ADMIN |
| `POST` | `/api/approvals/:id/cancel` | any signed-in |
| `POST` | `/api/approvals/:id/decide` | any signed-in |
| `POST` | `/api/approvals/:id/reassign` | ADMIN |
| `GET` | `/api/approvals/:id` | any signed-in |
| `POST` | `/api/approvals/bulk-decide` | ADMIN, IT_OPERATOR |
| `GET` | `/api/approvals/counts` | any signed-in |
| `GET` | `/api/approvals` | any signed-in |
| `GET` | `/api/assets/:id/as-of` | any signed-in |
| `POST` | `/api/assets/:id/assign` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/:id/check-in` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/:id/clear-flag` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/:id/correct` | ADMIN |
| `POST` | `/api/assets/:id/repair-done` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/:id/repair` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/:id/retire` | ADMIN, IT_OPERATOR |
| `GET` | `/api/assets/:id` | any signed-in |
| `PATCH` | `/api/assets/:id` | any signed-in |
| `GET` | `/api/assets/:id/timeline` | any signed-in |
| `GET` | `/api/assets/:id/qr` | any signed-in (scoped); `?format=svg|png`, `&download=1` |
| `POST` | `/api/assets/bulk-add` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/bulk-check-in` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/bulk-reassign` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/bulk-status` | ADMIN, IT_OPERATOR |
| `POST` | `/api/assets/check-duplicates` | any signed-in |
| `POST` | `/api/assets/labels` | any signed-in (scoped); body `assetIds`, optional `layout`, `skip`; `?inline=1` for preview |
| `GET` | `/api/assets/lookup` | any signed-in (scoped); `q` may be an Asset ID, serial, legacy tag or scan link |
| `GET` | `/api/assets` | any signed-in |
| `POST` | `/api/assets` | ADMIN, IT_OPERATOR |
| `GET` | `/api/audit/meta` | ADMIN, IT_OPERATOR |
| `GET` | `/api/audit` | ADMIN, IT_OPERATOR |
| `POST` | `/api/auth/change-password` | any signed-in |
| `POST` | `/api/auth/forgot` | public |
| `POST` | `/api/auth/login` | public |
| `POST` | `/api/auth/logout` | public |
| `GET` | `/api/auth/me` | any signed-in |
| `POST` | `/api/auth/reset` | public |
| `PATCH` | `/api/categories/:id` | ADMIN |
| `GET` | `/api/categories` | any signed-in |
| `POST` | `/api/categories` | ADMIN |
| `GET` | `/api/dashboard` | any signed-in |
| `PATCH` | `/api/departments/:id` | ADMIN, IT_OPERATOR |
| `GET` | `/api/departments` | any signed-in |
| `POST` | `/api/departments` | ADMIN, IT_OPERATOR |
| `GET` | `/api/documents/:id/download` | any signed-in |
| `POST` | `/api/documents/:id/restore` | ADMIN |
| `DELETE` | `/api/documents/:id` | ADMIN |
| `GET` | `/api/documents` | any signed-in |
| `POST` | `/api/documents` | any signed-in |
| `POST` | `/api/employees/:id/offboard` | ADMIN, IT_OPERATOR |
| `GET` | `/api/employees/:id` | any signed-in |
| `PATCH` | `/api/employees/:id` | ADMIN, IT_OPERATOR |
| `GET` | `/api/employees` | any signed-in |
| `POST` | `/api/employees` | ADMIN, IT_OPERATOR |
| `POST` | `/api/imports/:id/cancel` | ADMIN, IT_OPERATOR |
| `POST` | `/api/imports/:id/confirm` | ADMIN, IT_OPERATOR |
| `GET` | `/api/imports/:id/report` | ADMIN, IT_OPERATOR |
| `GET` | `/api/imports/:id` | ADMIN, IT_OPERATOR |
| `GET` | `/api/imports/:id/rows` | ADMIN, IT_OPERATOR |
| `GET` | `/api/imports` | ADMIN, IT_OPERATOR |
| `POST` | `/api/imports` | ADMIN, IT_OPERATOR |
| `GET` | `/api/imports/template` | ADMIN, IT_OPERATOR |
| `POST` | `/api/integrations/:source/devices` | API key (Bearer) |
| `POST` | `/api/integrations/conflicts/:id/resolve` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/conflicts` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/health` | ADMIN, IT_OPERATOR |
| `POST` | `/api/integrations/runs/:id/acknowledge` | ADMIN, IT_OPERATOR |
| `POST` | `/api/integrations/runs/:id/retry` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/runs/:id` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/runs` | ADMIN, IT_OPERATOR |
| `POST` | `/api/integrations/sources/:id/api-key` | ADMIN |
| `DELETE` | `/api/integrations/sources/:id/api-key` | ADMIN |
| `POST` | `/api/integrations/sources/:id/pull` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/sources/:id` | ADMIN, IT_OPERATOR |
| `PUT` | `/api/integrations/sources/:id` | ADMIN |
| `POST` | `/api/integrations/sources/:id/sync` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/sources` | ADMIN, IT_OPERATOR |
| `POST` | `/api/integrations/sources` | ADMIN |
| `POST` | `/api/integrations/unmatched/:id/resolve` | ADMIN, IT_OPERATOR |
| `GET` | `/api/integrations/unmatched` | ADMIN, IT_OPERATOR |
| `GET` | `/api/locations/:id/as-of` | any signed-in |
| `PATCH` | `/api/locations/:id` | ADMIN |
| `GET` | `/api/locations` | any signed-in |
| `POST` | `/api/locations` | ADMIN |
| `POST` | `/api/notifications/read` | any signed-in |
| `GET` | `/api/notifications` | any signed-in |
| `PUT` | `/api/reminder-policies/:id` | ADMIN |
| `GET` | `/api/reminder-policies` | ADMIN, IT_OPERATOR |
| `POST` | `/api/reminder-policies` | ADMIN |
| `POST` | `/api/renewables/:id/acknowledge` | any signed-in |
| `POST` | `/api/renewables/:id/cancel` | ADMIN, IT_OPERATOR |
| `POST` | `/api/renewables/:id/renew` | ADMIN, IT_OPERATOR |
| `GET` | `/api/renewables/:id` | any signed-in |
| `PATCH` | `/api/renewables/:id` | ADMIN, IT_OPERATOR |
| `POST` | `/api/renewables/:id/snooze` | any signed-in |
| `GET` | `/api/renewables` | any signed-in |
| `POST` | `/api/renewables` | ADMIN, IT_OPERATOR |
| `GET` | `/api/reports/:key` | any signed-in |
| `GET` | `/api/reports` | any signed-in |
| `DELETE` | `/api/saved-filters/:id` | any signed-in |
| `GET` | `/api/saved-filters` | any signed-in |
| `POST` | `/api/saved-filters` | any signed-in |
| `GET` | `/api/organizations` | any signed-in |
| `POST` | `/api/organizations` | ADMIN, IT_OPERATOR |
| `GET` | `/api/settings/public` | public |
| `GET` | `/api/settings` | ADMIN, IT_OPERATOR |
| `PATCH` | `/api/settings` | ADMIN |
| `GET` | `/api/settings/asset-ids` | ADMIN |
| `PUT` | `/api/settings/asset-ids` | ADMIN |
| `POST` | `/api/settings/asset-ids/preview` | ADMIN |
| `PUT` | `/api/settings/labels` | ADMIN |
| `POST` | `/api/users/:id/invite` | ADMIN |
| `POST` | `/api/users/:id/reset-password` | ADMIN |
| `GET` | `/api/users/:id` | ADMIN, IT_OPERATOR |
| `PATCH` | `/api/users/:id` | ADMIN |
| `POST` | `/api/users/:id/unlock` | ADMIN |
| `GET` | `/api/users` | ADMIN, IT_OPERATOR |
| `POST` | `/api/users` | ADMIN |
| `POST` | `/api/verification/campaigns/:id/close` | ADMIN, IT_OPERATOR |
| `GET` | `/api/verification/campaigns/:id` | any signed-in |
| `GET` | `/api/verification/campaigns` | any signed-in |
| `POST` | `/api/verification/campaigns` | ADMIN, IT_OPERATOR |
| `GET` | `/api/verification/discrepancies` | any signed-in |
| `POST` | `/api/verification/tasks/:id/lines/:lineId/review` | ADMIN, IT_OPERATOR |
| `GET` | `/api/verification/tasks/:id/lines` | any signed-in |
| `POST` | `/api/verification/tasks/:id/mark-all` | any signed-in |
| `POST` | `/api/verification/tasks/:id/mark` | any signed-in |
| `POST` | `/api/verification/tasks/:id/reopen` | ADMIN, IT_OPERATOR |
| `GET` | `/api/verification/tasks/:id` | any signed-in |
| `POST` | `/api/verification/tasks/:id/scan` | any signed-in |
| `POST` | `/api/verification/tasks/:id/sign-off` | ADMIN, IT_OPERATOR |
| `POST` | `/api/verification/tasks/:id/submit` | any signed-in |
| `POST` | `/api/verification/tasks/:id/unlisted/:uid/review` | ADMIN, IT_OPERATOR |
| `DELETE` | `/api/verification/tasks/:id/unlisted/:uid` | any signed-in |
| `POST` | `/api/verification/tasks/:id/unlisted` | any signed-in |
| `GET` | `/api/verification/tasks/:id/verified-stock` | any signed-in |
| `GET` | `/api/verification/tasks` | any signed-in |
