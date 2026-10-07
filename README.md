# IT Asset Lifecycle Management — Phase 1

A web application for tracking IT assets across one or more organizations. It covers registration, assignment and transfer (both done from the asset register), approvals, physical verification, renewals and reminders, documents, bulk import, integrations and an append-only audit trail.

This repository implements **Phase 1 only** (cuts A, B and R1 of the FRD). Procurement, sourcing, vendors, quotations, comparison, PO write-back and AI extraction are Phase 2. They are not implemented, stubbed or exposed anywhere. See [docs/PHASE1-CHECKLIST.md](docs/PHASE1-CHECKLIST.md) for the requirement-by-requirement status and the Phase 2 safety check.

## What it does

| Area | Highlights |
|---|---|
| Access | Three roles (Administrator, IT Operator, Branch User). Branch users see only their location subtree, enforced on the server for every read, write, report and export. Password policy, lockout, idle and absolute session timeouts, reset by email. |
| Register | System-issued Asset IDs that the database refuses to change. Serial and legacy-tag duplicates block; hostname and IP duplicates warn and need a reason. Bulk add by model × quantity, scanner-friendly entry and QR labels. |
| Lifecycle | Assign, check-in, repair and retire, single or in bulk (all-or-nothing), each optionally approval-gated. |
| Transfers | Assigning assets to a location, from the asset register, moves them there in one action, one asset or many. The move is recorded on each asset's history and audit trail. |
| Approvals | Configurable policies by category, cost, bulk size, inter-state and initiator role, with sequential or parallel steps. The requester cannot approve their own request. |
| Physical Audit | Audits snapshot each branch. Branches mark Present, Missing or Wrong details and add unlisted assets. IT reviews and signs off. Quarterly recurrence. |
| Renewals | Warranties, licences, AMCs and more. Tiered reminders fire once per cycle, with acknowledge, snooze, renew and escalation. |
| Imports | CSV and Excel, 20,000 rows. Async dry run with a row report, then an atomic commit that refuses to apply if the data changed. |
| Integrations | Generic authenticated device hook (push) and pull. AD/LDAP directory sync. Field-level overwrite, warn and ignore rules, a conflict queue, an unmatched queue and idempotent batches. |
| Audit and reports | Append-only audit log. Fourteen standard reports whose export always equals the screen. Dashboards reconcile with the register. |

## Quick start (development)

```bash
cp .env.example .env              # set DATABASE_URL and ENCRYPTION_KEY (openssl rand -base64 32)
npm install
npm run db:migrate                # apply migrations
npm run db:seed                   # DEVELOPMENT ONLY demo data (~5 of each, 5 people (3 sign-ins), Kerala only)
npm run dev                       # web on http://localhost:3000 plus the background worker
```

The seed prints the demo sign-ins. These accounts are **for development only**. They share the password in `SEED_DEMO_PASSWORD`, or a documented default when that is empty, and the seed refuses to run in production. The application has no built-in or hard-coded accounts.

Full instructions: [docs/SETUP.md](docs/SETUP.md).

## Documentation

- [docs/SETUP.md](docs/SETUP.md): local setup, environment variables, demo data, volume data
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure, security model, workflows, and the decisions taken where the FRD was silent
- [docs/DATABASE.md](docs/DATABASE.md): schema, invariants enforced in PostgreSQL, migrations
- [docs/API.md](docs/API.md): conventions, error format, the integration hook, the full route list
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Docker Compose, TLS, email, backups, operations
- [docs/TESTING.md](docs/TESTING.md): automated tests, performance check results, manual test notes
- [docs/PHASE1-CHECKLIST.md](docs/PHASE1-CHECKLIST.md): Phase 1 requirement coverage and Phase 2 safety check

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Web app and worker with reload |
| `npm run build` / `npm start` | Production build and web server |
| `npm run worker` | Background worker (imports, email, reminders, schedules, integrations) |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Demo data, ~5 of each, 5 people (3 sign-ins), South India locations, development only |
| `npm run db:seed:large` | Large demo organisation for volume and load tests |
| `npm run db:reset-demo -- --yes` | Deletes all data and loads the demo data (~5 of each, 5 people (3 sign-ins)), development only |
| `npm run db:south-only -- --yes` | Keeps only South India locations in an existing database, moving what was elsewhere (dry run without `--yes`), development only |
| `npm run mail:test -- you@x.com` | Sends one test email with the configured `SMTP_URL` |
| `npm run db:trim-assets -- --yes` | Keeps 5 assets and deletes the rest with their history, development only |
| `npm run db:generate-volume -- --assets 20000` | Volume data for performance testing, development only |
| `npm test` | Automated tests against a disposable `*_test` database |
| `npm run perf:check` | Times the NFR-02 targets against a volume database |
| `npm run load:test -- --sessions 50` | Concurrent-session load test over HTTP (development or staging only) |
| `npm run typecheck` / `npm run lint` | Static checks |

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Prisma 6 · PostgreSQL 16 · zod · Vitest.
