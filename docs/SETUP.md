# Setup (development)

## Prerequisites

- Node.js 20 or later (developed on 22) and npm
- PostgreSQL 14 or later with the `pg_trgm` extension available (standard in the official images)
- Optional: Docker, for Mailpit (a local mail catcher) and ClamAV

## Steps

```bash
git clone https://github.com/Sreelakshmi-Sekhar-04/asset-management-tool.git
cd asset-management-tool
npm install

cp .env.example .env
#   DATABASE_URL   → your local database
#   ENCRYPTION_KEY → openssl rand -base64 32
#   APP_URL        → http://localhost:3000

npm run db:migrate      # create the schema
npm run db:seed         # DEVELOPMENT ONLY: 2 organizations, ~5 of each, 3 users
npm run dev             # web app on http://localhost:3000 plus the worker
```

`npm run dev` starts both the Next.js dev server and the background worker. Without the worker, imports stay queued and no email or reminders go out.

## Environment variables

Every variable is described in [`.env.example`](../.env.example). Required: `DATABASE_URL`, `ENCRYPTION_KEY`, `APP_URL`. Never commit `.env`; it is in `.gitignore`.

## Demo data (development only)

`npm run db:seed` loads a deliberately small demo set, so the application reloads quickly: **2 organizations** (Tropicana Kochi and Tropicana Kozhikode, the head quarters), **5 locations** (3 branches under the first, 2 under the second), **5 departments** (each belonging to one organization), **5 categories**, **5 employees**, **5 assets**, **3 users** (an Administrator, an IT Operator and a branch user, each linked to their employee record) and the 5 warranty renewals those assets create. The records are split between the two organizations, so switching organization visibly changes every list. It skips a database that already has users.

For a large realistic organisation (15 branches, ~150 assets, approval policies, a verification campaign), run `npm run db:seed:large` on an empty database instead. The volume and load tests below use it.

It prints the sign-ins when it finishes. All demo accounts share one password: `SEED_DEMO_PASSWORD` if set, otherwise the development default printed by the seed. **These are development credentials.** They exist only in a database you seeded, the application has no built-in accounts, and the seed refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` (never set that on a live system).

To start again from an empty development database, run `npm run db:reset`. This **drops all data** in the database named by `DATABASE_URL`, so use it only on a local development database.

For a small demo set instead, run `npm run db:reset-demo -- --yes`. It **deletes all data** in the database named by `DATABASE_URL` (users, assets, history and audit log included) and loads the same small demo set as `npm run db:seed`. Migrations, saved settings and the Asset ID counters are kept, so new Asset IDs continue after the old ones. Add `--admin-email you@company.com --admin-name "Your Name"` to make the Administrator your own email. All three accounts use the demo password (`SEED_DEMO_PASSWORD`, or `Demo#Pass2026`).

To keep your existing data but cut the asset register down, run `npm run db:trim-assets -- --yes`. It keeps the 5 most recently added assets (or `--keep N`, or exactly `--codes AST-000001,AST-000002`) and **permanently deletes** every other asset with its history, renewals and documents, plus every transfer that contains a deleted asset. Without `--yes` it only prints what it would delete. Users, employees, locations, settings and the audit log are kept.

## Volume data (performance testing)

```bash
createdb itam_volume
DATABASE_URL=postgresql://…/itam_volume npm run db:migrate
DATABASE_URL=postgresql://…/itam_volume npm run db:seed:large
DATABASE_URL=postgresql://…/itam_volume npm run db:generate-volume -- --assets 20000
DATABASE_URL=postgresql://…/itam_volume npm run perf:check
```

`--branch "<name>"` puts all generated assets in one branch, which is needed to time a 2,000-asset transfer. Use a separate database: the performance check creates transfers and imports.

## Email in development

Leave `SMTP_URL` empty to log recipient and subject only, or run Mailpit and point at it:

```bash
docker compose --profile dev up -d mailpit
# .env: SMTP_URL=smtp://localhost:1025
# open http://localhost:8025
```

## First real (non-demo) start

On an empty production database there are no users. Create the first Administrator from the command line on the server:

```bash
npx tsx scripts/create-admin.ts --email you@company.com --name "Your Name"
```

It prompts for a password (checked against the password policy) and never echoes or logs it. Then sign in and use Admin → Users for everyone else.
