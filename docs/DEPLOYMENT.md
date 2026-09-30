# Deployment

## Components

| Component | Runs | Notes |
|---|---|---|
| Web | `npm start` (Next.js server, port 3000) | Stateless; scale horizontally behind a load balancer |
| Worker | `npm run worker` | Imports, email outbox, daily reminders and schedules, integration schedules. Run at least one; several are safe (jobs and daily tasks are claimed atomically). |
| PostgreSQL | 14+ | Needs the `pg_trgm` extension |
| File storage | a persistent volume at `STORAGE_DIR` | Uploaded documents and import files. Must be shared by web and worker and backed up. |
| SMTP relay | via `SMTP_URL` | Required in production. Without it, queued mail is marked failed and shows in the outbox. |
| Virus scanner | optional ClamAV or HTTP scanner | `VIRUS_SCAN_MODE` |

## Docker Compose

`Dockerfile` builds one image used for web, worker and migrations. `docker-compose.yml` runs PostgreSQL, a one-off `migrate` step, web, worker and a nightly database backup.

```bash
cp .env.example .env
#   APP_URL=https://assets.example.com
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   SMTP_URL=smtp://user:pass@smtp.example.com:587
#   MAIL_FROM="IT Assets <it-assets@example.com>"
#   FORCE_HTTPS=true
export POSTGRES_PASSWORD='<a long random password>'   # or add it to .env
docker compose up -d --build
docker compose run --rm web npx tsx scripts/create-admin.ts --email you@example.com --name "Your Name"
```

Compose reads secrets from `.env` and the environment. Nothing secret is in the compose file or the image. Do **not** run `npm run db:seed` in production. It refuses anyway unless `ALLOW_DEMO_SEED=true`.

Profiles: `--profile dev` adds Mailpit (development mail catcher); `--profile clamav` adds ClamAV (then set `VIRUS_SCAN_MODE=clamav`, `CLAMAV_HOST=clamav`).

> The Dockerfile and compose file were written for this release but not built in the development container, which has no Docker daemon. `npm run build` and the full test suite were verified there. Build the image once in your environment before relying on it.

## Without Docker

```bash
npm ci
npm run build
npm run db:migrate
npm start            # web, e.g. under systemd or pm2
npm run worker       # worker, as a second service
```

## TLS and the reverse proxy

Terminate TLS at a reverse proxy (nginx, Caddy, a cloud load balancer) and forward to port 3000. Then:

- set `FORCE_HTTPS=true` (HSTS header and `Secure` session cookie) and an `https://` `APP_URL`
- pass `X-Forwarded-For` so sign-in rate limiting and the audit log see real client IPs
- allow request bodies up to 25 MB for imports (for example `client_max_body_size 25m;`)

## Upgrades

1. Back up the database and storage volume.
2. Deploy the new image or code.
3. Run migrations (`docker compose up migrate` or `npm run db:migrate`). Migrations only move forward and never drop data. `prisma migrate reset` must never be run against a live database.
4. Restart web and worker.

## Backups and restore

- **Database.** The `backup` service writes `pg_dump -Fc` files to the `backups` volume nightly and keeps 14 days. Copy that volume off the host. Restore with `pg_restore --clean --if-exists -d itam <file>` into a stopped stack.
- **Files.** Back up the `storage` volume (documents, import files) on the same schedule. A database restore without the matching files leaves documents unreadable.
- Test a restore periodically on a separate host.

## Operations

- **Health.** `GET /api/health` returns 200 when the app can reach the database. The image's `HEALTHCHECK` uses it.
- **Email.** Admin → Email outbox shows every message with status and last error. Failed messages retry with back-off and can be retried by hand.
- **Integrations.** Integrations → health shows the last run per source. Failures and unmatched surges alert Administrators.
- **Logs** go to stdout/stderr. They never contain passwords, tokens, API keys or email bodies.
- **Secrets rotation.** API keys are rotated per source in the UI (the old key stops working immediately). Changing `ENCRYPTION_KEY` makes stored integration secrets unreadable, so re-enter them after a change.
