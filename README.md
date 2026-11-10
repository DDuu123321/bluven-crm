# Bluven CRM

Sales CRM for Bluven, a residential solar and battery installer. It takes a lead from the moment it
arrives to the moment operations accepts the finished order:

lead intake and duplicate detection → assignment → follow-up (timeline, tasks, documents) → quote and
signed contract (designed in Pylon) → deposit confirmed by finance → handoff to operations, with a
return loop when something is missing.

**Status:** Phase 1 (the sales side without email sync and AI) is built and tested. Zoho Mail sync
(Phase 2) and AI summaries (Phase 3) are designed but not built yet.

## Documentation

| Document | For | Language |
|---|---|---|
| [docs/sales-process-guide.md](docs/sales-process-guide.md) | Sales, managers, finance, operations: how the process works | 中文 |
| [docs/deployment-guide.md](docs/deployment-guide.md) | Whoever installs and runs the system | 中文 |
| [docs/bluven-lead-forwarding-spec.md](docs/bluven-lead-forwarding-spec.md) | The Bluven website developer: how to forward leads | 中文 |
| [docs/sales-crm-design.md](docs/sales-crm-design.md) | Developers: design, data model, rules, phases | 中文 |

## Repository layout

```
apps/web                Next.js 16 application: all pages, Server Actions and the HTTP API
apps/worker             Background process: idle rules, reminders, notification emails, Pylon events
packages/db             Prisma schema, migrations and the database client
packages/core           Business rules (src/domain) and application services (src/services)
packages/integrations   Pylon: API client, webhook verification, event processing
e2e                     Playwright tests that drive the built application through the whole journey
deploy                  Caddyfile, environment template and backup script for Docker Compose
docs                    The documents listed above
```

Things worth knowing before changing the code:

- **The stage of an order is derived, never set.** `deriveStage` in `packages/core/src/domain/stages.ts`
  computes it from recorded facts (first contact, quote sent, live contract, open deposit, latest
  handoff decision). Services change a fact and call `syncOrderStage`.
- **Permissions live in the services.** Every function in `packages/core/src/services` checks who is
  acting. Pages and Server Actions only establish the signed-in user and call a service.
- **Everything is audited.** Each change writes a row to `AuditLog` in the same transaction. A
  database trigger blocks updates and deletes on that table.
- **Uploaded files** go to `STORAGE_DIR` on disk and are only served through `/api/documents/…`
  after an access check. Each view and download is logged.

## Requirements

- Node.js 22 or newer and pnpm 10 (`corepack enable`)
- PostgreSQL 16

## Development

```bash
cp .env.example .env            # then adjust DATABASE_URL and the seed admin
createdb bluven_dev && createdb bluven_test

pnpm install
pnpm db:deploy                  # apply the migrations
pnpm db:seed                    # reference data and the first admin account

pnpm dev                        # web application on http://localhost:3000
pnpm dev:worker                 # background jobs, in a second terminal
```

Sign in with the seed admin from `.env`. You are asked to choose a new password, then add the other
users under Administration → Users.

After changing `packages/db/prisma/schema.prisma`, run `pnpm db:migrate` to create and apply a migration.

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm test       # unit and integration tests; uses the database in DATABASE_URL_TEST
pnpm e2e        # builds the app and drives it in a browser; uses its own database (bluven_e2e) on port 3100
```

`pnpm e2e` needs Chromium for Playwright once: `pnpm --filter @bluven/e2e exec playwright install chromium`.
It leaves full-page screenshots of the main screens in `e2e/screenshots`.

## Production

The stack runs with Docker Compose on a single server: PostgreSQL, the web application, the worker
and Caddy for HTTPS. The short version:

```bash
cp deploy/env.production.example .env    # fill in the domain, a database password and the first admin
docker compose up -d --build
```

The full procedure, including the first-time set-up inside the CRM, backups and upgrades, is in
[docs/deployment-guide.md](docs/deployment-guide.md).

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | required |
| `APP_URL` | Public address of the CRM, no trailing slash. Used in links and for the secure-cookie decision | `http://localhost:3000` |
| `APP_TIMEZONE` | Business time zone for dates on screen and date-only fields | `Australia/Sydney` |
| `STORAGE_DIR` | Directory for uploaded files | `./data/storage` |
| `MAX_UPLOAD_MB` | Largest single upload | `500` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD` | First administrator, created by `pnpm db:seed` when no user exists | none |
| `SMTP_URL`, `MAIL_FROM` | Outgoing notification emails. Leave `SMTP_URL` empty to switch them off | off |
| `PYLON_API_TOKEN`, `PYLON_WEBHOOK_SECRET`, `PYLON_API_BASE` | Pylon connection. Without them quotes and contracts are entered by hand | off |
| `DATABASE_URL_TEST`, `DATABASE_URL_E2E` | Databases for `pnpm test` and `pnpm e2e` | see `.env.example` |

## HTTP API

| Endpoint | Purpose | Authentication |
|---|---|---|
| `POST /api/intake/leads` | Receives leads from the Bluven website and other sources | Bearer token per lead source |
| `GET /api/intake/health` | Liveness probe | none |
| `POST /api/webhooks/pylon` | Receives events from Pylon | HMAC signature |

Everything else under `/api` serves the application's own pages and requires a signed-in session.
