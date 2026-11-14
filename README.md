# Bluven CRM

CRM for Bluven, a residential solar and battery installer. It takes a lead from the moment it
arrives to the moment the job is closed with the final payment:

lead intake and duplicate detection → assignment by the manager → the salesperson opens the job and
says where the customer came from → follow-up (timeline, tasks, documents) → design in Pylon and
proposal by e-mail → deposit → push to operations → operations accept the order (confirming the
deposit), arrange the installation and mark the job as done → final payment, job closed. The
customer is written to automatically at three points; operations send an order back to sales only
when they cannot sort something out themselves.

**Status:** the whole flow is built and tested: sales, operations up to the closed job, customer
e-mail through Zoho Mail, the AI assistant, document retention, the report and e-mail templates.
Zoho Mail (including the automatic e-mails to customers) and the assistant have only been run
against local stand-ins, never against the real services. Not built: a connection to accounting
software, a time zone per customer or salesperson, public holidays in working-day counts, creating
Pylon projects through the API, converting HEIC photos, and a layout for phones.

## Documentation

| Document | For | Language |
|---|---|---|
| [docs/sales-process-guide.md](docs/sales-process-guide.md) | Sales, managers, operations, finance: how an order goes from lead to closed job | 中文 |
| [docs/deployment-guide.md](docs/deployment-guide.md) | Whoever installs and runs the system | 中文 |
| [docs/bluven-lead-forwarding-spec.md](docs/bluven-lead-forwarding-spec.md) | Whoever maintains the Bluven website: how its leads reach the CRM | 中文 |
| [docs/sales-crm-design.md](docs/sales-crm-design.md) | Developers: design, data model, rules, phases | 中文 |

## Repository layout

```
apps/web                Next.js 16 application: all pages, Server Actions and the HTTP API
apps/worker             Background process: idle rules, reminders (tasks, and for operations the
                        rebate and the balance after a job is done), the automatic e-mails to
                        customers, notification emails and daily summaries, Pylon events, collecting
                        the website's leads, reading connected mailboxes, the assistant's
                        unattended work, document retention
packages/db             Prisma schema, migrations and the database client
packages/core           Business rules (src/domain) and application services (src/services)
packages/integrations   Pylon (API client, webhook verification, event processing), the pull of new
                        leads from the Bluven website, customer e-mail through Zoho Mail, and the
                        AI assistant (src/ai)
e2e                     Playwright tests that drive the built application through the whole journey
deploy                  Start script of the single-container image; Caddyfile, environment template
                        and backup script for Docker Compose
docs                    The documents listed above
```

Things worth knowing before changing the code:

- **The stage of an order is derived, never set.** `deriveStage` in `packages/core/src/domain/stages.ts`
  computes it from recorded facts (job opened, design started, proposal sent, open deposit, latest
  handoff decision, job done, job closed). Services change a fact and call `syncOrderStage`.
- **A lead is not a job until its salesperson opens it.** Work on an order (calls and notes, files,
  quotes, the deposit, sending e-mail) goes through `lockOrderForWork`, which requires that;
  correcting the customer's details does not.
- **Two things are called a source.** `LeadSource` is the channel a lead arrived through (the
  website, a file, by hand): "intake channel" in the interface. `LeadOrigin` is where the customer
  came from, chosen by the salesperson when opening the job: "lead source" in the interface, and
  what partners are paid by.
- **E-mails that go to customers by themselves** are rows in `CustomerNotice`, written from
  templates an admin keeps and fixed at the moment they are queued. The worker sends them.
- **Permissions live in the services.** Every function in `packages/core/src/services` checks who is
  acting. Pages and Server Actions only establish the signed-in user and call a service.
- **Everything is audited.** Each change writes a row to `AuditLog` in the same transaction.
  Database triggers refuse UPDATE, DELETE and TRUNCATE on that table.
- **Uploaded files** go to `STORAGE_DIR` on disk and are only served through `/api/documents/…`
  after an access check. Each view and download is logged.

## A look on your own computer

To see the CRM with sample accounts and orders, without setting anything up for real, install
[Docker Desktop](https://www.docker.com/products/docker-desktop/), start it, and run this in the
folder with the code:

```bash
docker compose -f docker-compose.local.yml up --build
```

The first start builds the application and takes several minutes. Then open
<http://localhost:3000>. Every demo account has the password `Bluven-demo-1`.

| Sign in as | Role | What you see first |
|---|---|---|
| `manager@bluven.demo` | Manager | The dashboard, every order, the unassigned leads |
| `sam@bluven.demo`, `alex@bluven.demo` | Sales | Their own orders, tasks and reminders |
| `finance@bluven.demo` | Finance | Deposits, balances that are due, final payments |
| `ops@bluven.demo` | Operations | The order to accept, the jobs being arranged and the one waiting for its balance |
| `admin@bluven.demo` | Admin | Users, rules and the integrations |

The sample data is sixteen orders at different points: two unassigned leads, a lead that is
assigned and not opened yet, orders being followed up, in design and with a proposal out (one of
them quiet for six days, so the idle reminder shows), two with a deposit (one ready to push), one
pushed and waiting for operations, one being arranged by operations, one installed with its
balance overdue, one completed, and one each lost and on hold. Customer e-mail, the AI assistant,
Pylon and notification e-mails are not connected in the demo; their pages say so, and the e-mails
to customers are kept on the orders, marked as not sent.

Stop it with Ctrl+C. `docker compose -f docker-compose.local.yml down -v` throws the demo
database away, so the next start begins with fresh sample data. If port 3000 is taken, put
`CRM_PORT=3001` in front of the command (PowerShell: `$env:CRM_PORT=3001` on a line before it).

Without Docker, on a machine that has Node.js and PostgreSQL: follow *Development* below and run
`DEMO_DATA=1 pnpm db:demo` in place of `pnpm db:seed` (PowerShell: `$env:DEMO_DATA=1`, then
`pnpm db:demo`). It only fills a database that has no users and no orders yet.

This is for looking around, not for real use: plain HTTP, and accounts whose password is printed
above. *Production* below describes the real thing.

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

`pnpm install` also points git at the hooks in `.githooks`. They enforce the rule on who a commit
is attributed to, which is written down in [AGENTS.md](AGENTS.md).

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

No test talks to an outside service. Zoho and the language model are played by small local servers
(`e2e/scripts/fake-zoho.ts`, `e2e/scripts/fake-model.ts`) that speak the same HTTP as the real
ones, so the application's own client code runs against them unchanged.

## Production

The CRM is served at `https://crm.bluven.com.au`, next to the website (`www`) and its CMS (`cms`).
There are two supported ways to host it:

- **Railway**, like the website's CMS. The `Dockerfile` built without a target gives one image
  that migrates the database and runs the web server and the worker together
  (`deploy/start.mjs`), with a volume mounted at `/data` for the files.
- **Your own server** with Docker Compose: PostgreSQL, the web application, the worker and Caddy
  for HTTPS as separate containers. The short version:

  ```bash
  cp deploy/env.production.example .env    # a database password and the first admin
  docker compose up -d --build
  ```

Both procedures, the DNS record, connecting the website's leads, the first-time set-up inside the
CRM, backups and upgrades are in [docs/deployment-guide.md](docs/deployment-guide.md).

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | required |
| `APP_URL` | Public address of the CRM, no trailing slash. Used in links and for the secure-cookie decision | `http://localhost:3000` |
| `APP_TIMEZONE` | Business time zone for dates on screen, date-only fields and the working days counted after a job is done | `Australia/Sydney` |
| `STORAGE_DIR` | Directory for uploaded files | `./data/storage` |
| `MAX_UPLOAD_MB` | Largest single file on the Documents tab. Proposal files, signed copies and deposit proofs go through forms with a fixed limit of 60 MB and ten files per submission | `500` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD` | First administrator, created by `pnpm db:seed` when no user exists | none |
| `BLUVEN_LEADS_URL`, `BLUVEN_LEADS_KEY` | Collect new leads from the Bluven website's CMS once a minute (`GET /api/crm/leads` there). The key equals `CRM_SYNC_KEY` on the CMS | off |
| `BLUVEN_LEADS_SINCE` | First run only: also take over leads created since this time, as history | from now |
| `MAIL_RELAY_URL`, `MAIL_RELAY_KEY` | Send notification emails through an HTTPS relay (the website's `/api/send-mail`). For hosts that block outgoing SMTP; wins over SMTP when both are set | off |
| `SMTP_URL`, `MAIL_FROM` | Send notification emails by SMTP | off |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Customer e-mail: the Zoho application through which each salesperson connects their own mailbox (redirect address `<APP_URL>/api/zoho/callback`). The automatic e-mails to customers go out through a connected mailbox too. The secret also protects the stored mailbox tokens | off |
| `ZOHO_ACCOUNTS_URL`, `ZOHO_MAIL_URL` | Zoho's sign-in and mail addresses, for an account outside the Australian data centre | `accounts.zoho.com.au`, `mail.zoho.com.au` |
| `ZOHO_REQUESTS_PER_MINUTE` | The most requests the worker sends Zoho in a minute while reading mailboxes, all mailboxes together. Zoho blocks an application that passes 30 | `24` |
| `ANTHROPIC_API_KEY` | The AI assistant: order summaries, drafts for e-mails, recognising attachments, reading electricity bills, the brief for operations. A key for Anthropic's API | off |
| `AI_MODEL` | The model the assistant uses | `claude-opus-5-5` |
| `PYLON_API_TOKEN`, `PYLON_API_BASE` | Pylon connection: the worker reads Pylon's events every minute. Without a token quote versions are entered by hand | off |
| `PYLON_WEBHOOK_SECRET` | Optional: lets Pylon deliver the same events within seconds through `/api/webhooks/pylon` | off |
| `DATABASE_URL_TEST` | Database for `pnpm test` | see `.env.example` |
| `DATABASE_URL_E2E`, `E2E_PORT` | Database and port for `pnpm e2e`, so two checkouts can run it side by side | `bluven_e2e` on the local server, `3100` |
| `ANTHROPIC_BASE_URL` | Another address for the model's API: a gateway in front of it, or a stand-in in tests | Anthropic's own |

## HTTP API

| Endpoint | Purpose | Authentication |
|---|---|---|
| `POST /api/intake/leads` | Receives leads from the Bluven website and other sources | Bearer token per lead source |
| `GET /api/intake/health` | Liveness probe | none |
| `POST /api/webhooks/pylon` | Receives events from Pylon (optional; the worker also reads them itself) | HMAC signature |
| `GET /api/zoho/connect`, `GET /api/zoho/callback` | Start and finish connecting a salesperson's Zoho mailbox | signed-in session, plus a one-time value kept in a cookie |

Everything else under `/api` serves the application's own pages and requires a signed-in session.
