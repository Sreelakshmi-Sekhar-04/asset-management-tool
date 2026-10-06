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
npm run db:seed         # DEVELOPMENT ONLY: demo organisation, users, assets, transfers, renewals
npm run dev             # web app on http://localhost:3000 plus the worker
```

`npm run dev` starts both the Next.js dev server and the background worker. Without the worker, imports stay queued and no email or reminders go out.

## Environment variables

Every variable is described in [`.env.example`](../.env.example). Required: `DATABASE_URL`, `ENCRYPTION_KEY`, `APP_URL`. Never commit `.env`; it is in `.gitignore`.

## Demo data (development only)

`npm run db:seed` builds a realistic organisation:

- 3 regions, 6 states and 15 branches (Connaught Place … Surat)
- categories, departments and employees
- an Administrator, IT Operators and one branch user per branch
- assets in every state, transfers at each stage, approval policies, renewables and a verification campaign

It prints the sign-ins when it finishes. All demo accounts share one password: `SEED_DEMO_PASSWORD` if set, otherwise the development default printed by the seed. **These are development credentials.** They exist only in a database you seeded, the application has no built-in accounts, and the seed refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` (never set that on a live system).

To start again from an empty development database, run `npm run db:reset`. This **drops all data** in the database named by `DATABASE_URL`, so use it only on a local development database.

For a small demo set instead, run `npm run db:reset-demo -- --yes`. It **deletes all data** in the database named by `DATABASE_URL` (users, assets, history and audit log included) and loads 5 users, 5 locations, 5 departments, 5 categories, 5 employees, 5 assets (with 5 warranty renewals) and 5 transfers, one in each state. Migrations, saved settings and the Asset ID counters are kept, so new Asset IDs continue after the old ones. Add `--admin-email you@company.com --admin-name "Your Name"` to make the Administrator your own email. All five accounts use the demo password (`SEED_DEMO_PASSWORD`, or `Demo#Pass2026`).

To keep your existing data but cut the asset register down, run `npm run db:trim-assets -- --yes`. It keeps the 5 most recently added assets (or `--keep N`, or exactly `--codes AST-000001,AST-000002`) and **permanently deletes** every other asset with its history, renewals and documents, plus every transfer that contains a deleted asset. Without `--yes` it only prints what it would delete. Users, employees, locations, settings and the audit log are kept.

## Volume data (performance testing)

```bash
createdb itam_volume
DATABASE_URL=postgresql://…/itam_volume npm run db:migrate
DATABASE_URL=postgresql://…/itam_volume npm run db:seed
DATABASE_URL=postgresql://…/itam_volume npm run db:generate-volume -- --assets 20000
DATABASE_URL=postgresql://…/itam_volume npm run perf:check
```

`--branch "<name>"` puts all generated assets in one branch, which is needed to time a 20,000-line transfer. Use a separate database: the performance check creates transfers and imports.

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
