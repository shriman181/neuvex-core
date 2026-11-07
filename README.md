# neuvex-core

The core of [Neuvex](https://neuvex.cloud): the control plane, gateway and sandbox infrastructure, built on Neon Postgres and Cloudflare Workers.

The full design is in the [Neuvex on Neon infrastructure plan](https://claude.ai/artifact/LNs4S9XGf3bwAKnevrVgPN). This repo is at **Phase 3 (vendor projects and sandboxes), part 1**: the control plane on Neon, a contract engine, the gateway Worker with its audit log, and a provisioner that gives each vendor its own Neon project with a fixtures branch. Next: the gateway writing audit events into each vendor's project (part 2), then sandbox branches, publish and rollback (part 3).

## Control plane

Eight tables in the `control` schema. Every row belongs to one vendor.

| Table | Holds |
| --- | --- |
| `vendors` | Each software company on Neuvex: slug, tier, its Neon project and region |
| `vendor_keys` | Vendors' API keys, stored only as SHA-256 hashes plus a display prefix |
| `primitives` | Each capability a vendor exposes, named like `email.list_messages` |
| `contract_versions` | The rules for each version of a primitive. Immutable once written |
| `molds` | Interfaces built for a vendor's end users, keyed by the vendor's opaque user ID |
| `mold_versions` | Each published change to a mold, with its bundle and up/down SQL. Immutable |
| `agent_sessions` | Agent build sessions and their Neon sandbox branches |
| `usage_daily` | Molded sessions and primitive calls per vendor per day, for billing |

**Tenant isolation.** Row-level security is on for every table. A connection sees and writes only the rows of the vendor named in `app.vendor_id`, so every transaction from an app must start with:

```sql
SELECT set_config('app.vendor_id', '<vendor uuid>', true);
```

If it is not set, queries return no rows rather than everyone's. Child tables also reference their parent through `(vendor_id, id)`, so a row can never point at another vendor's primitive or mold, even from an admin connection. Table owners (`neuvex_migrator`) and Neon's admin role bypass row-level security; apps never use either.

**Data rules enforced by the database:** contract and mold versions can't be edited or deleted (only removed with their vendor), contracts must have an `allow` block, end-user references can't be email addresses, and slugs and primitive names must follow their formats.

## Gateway

A Cloudflare Worker (`apps/gateway`) that sits between an AI agent and a vendor's API. Before an agent's call goes through, the vendor's backend asks the gateway whether the call is allowed and gets back only the data the agent may see.

```http
POST /v1/check
Authorization: Bearer nvx_live_...
Content-Type: application/json

{
  "primitive": "email.list_messages",
  "action": "read",
  "fields": ["id", "subject", "from"],          // optional
  "session_id": "<agent session uuid>",          // optional
  "end_user_ref": "user_42",                     // optional; your opaque ID, never an email
  "data": [{ "id": "m1", "from": { "address": "ann@x.io" }, "body": "..." }]   // optional
}
```

It checks the key (scope `gateway:check`), loads the latest contract version for that primitive, and answers:

| Outcome | Response |
| --- | --- |
| Allowed | `200` with `decision: "allowed"`, `contract_version`, `allowed_fields`, `redact`, and `data` cut down to allowed fields with redacted paths set to `"[redacted]"` |
| Denied by the contract | `200` with `decision: "denied"`, `reason` (`action_denied`, `action_not_allowed`, `field_denied`, `field_not_allowed`, `missing_scope`, `no_contract`) and `detail` |
| Unknown primitive | `404` |
| Bad or missing key / missing scope | `401` / `403` (not audited: there is no vendor yet) |
| Bad request | `400`, or `413` over 1 MB |

Every decision with a known vendor is written to the audit log, daily usage is counted, and the key's `last_used_at` is updated, all in one transaction after the response is sent. `GET /health` answers without touching the database. Rate limits in contracts are stored but not yet enforced.

The Worker talks to Neon over HTTPS with Neon's serverless driver, as `neuvex_gateway`. Every query runs inside a transaction that first sets `app.vendor_id`, so row-level security limits it to the caller's vendor.

## Audit log

The `audit` schema in the control-plane database (in vendor projects from Phase 3).

- **`audit.events`**: one row per gateway decision, partitioned by UTC day. Partitions are created 14 days ahead, with a default partition as a safety net. Append-only: a trigger rejects every update and delete, even from admins, except deletes by the retention job.
- **`audit.checkpoints`**: one row per vendor per finished day: the event count, the last event id, and a SHA-256 hash over the day's events chained to the previous day's hash. `SELECT audit.verify_checkpoint('2026-11-07')` (with `app.vendor_id` set) recomputes it and says whether anything changed.
- **Retention by tier**: developer 7 days, startup 30, scale and enterprise 365.
- **Maintenance** (`audit.run_maintenance()`): partitions ahead, checkpoints for finished days, retention. The gateway's cron runs it every 6 hours, which also keeps Neon from archiving the production branch.

The gateway can insert events and read checkpoints for its own vendor. It cannot read, change or delete events.

## Vendor projects

Every vendor gets its own Neon project, `nvx-<slug>`, in the organization:

```
nvx-<slug>
├── production   root branch: the vendor's audit log, and later its molds' data
└── fixtures     schema-only root branch: the same schema with no real rows;
                 agent sandboxes will branch from here
```

**The vendor template** (`packages/vendor-db`) is what every vendor project runs, applied as the project's owner role:

- `neuvex.settings`: which vendor the project belongs to (set once, then fixed) and its audit retention.
- `neuvex_gateway`: the gateway's role there. It can insert audit events for that vendor only, read checkpoints, and run maintenance. It can't read, change or delete events, or create anything.
- `audit.events` and `audit.checkpoints`: the same append-only, hash-chained log as the control plane's. Retention drops whole daily partitions.

Template migrations are recorded in `neuvex.template_migrations` with a checksum. The runner refuses to continue if an applied migration was edited, or if the project is newer than the code.

**The provisioner** (`packages/provisioner`) does it in steps and saves each step in `control.vendors` before the next:

1. Create the Neon project with a `production` root branch (or find one an earlier run made).
2. Apply the template to production and record the vendor and its retention.
3. Give `neuvex_gateway` a random password, and store its connection string encrypted (AES-256-GCM, bound to the vendor ID) in `vendors.gateway_db_url_enc`.
4. Create `fixtures` as a schema-only branch, and record the template migrations it was copied with.
5. Mark the vendor `ready` with its template version.

It's safe to run again. After a failure (`provision_status = 'failed'`, with `provision_error`), it picks up where it stopped. On a ready vendor it applies any new template migrations and changes nothing else. The vendor row has to exist first. The provisioner can't create vendors, rename them or change tiers.

Run it from GitHub: **Actions → Provision vendor → Run workflow**, then enter the slug.

## Layout

```
neuvex-core/
  packages/db/                 control-plane schema, migrations, database client
    src/schema/namespace.ts    the `control` Postgres schema
    src/schema/tenancy.ts      the row-level security policy every table uses
    src/schema/*.ts            vendors, primitives, molds, sessions, usage
    src/schema/tables.ts       every control-plane table, re-exported (drizzle-kit reads this)
    src/index.ts               createDb(): Drizzle over Neon's HTTP driver, for Workers
    src/testing.ts             createTestDatabase(): in-memory Postgres set up like Neon
    migrations/                SQL migrations (generated, plus hand-written SQL)
    test/                      migration, isolation and audit tests on in-memory Postgres
    scripts/migrate.ts         applies migrations; prints Postgres's real error if one fails
    scripts/seed-demo.ts       demo vendor with three email primitives
    scripts/create-key.ts      a vendor API key, printed once
  packages/contracts/          contract rules: evaluate() a call, shape() the data
  packages/sql/                the Db interface: Neon over HTTP; PGlite in tests
  packages/neon-api/           Neon API client: projects, branches, connection strings, schema diff
  packages/vendor-db/          the template every vendor project runs, and its runner
  packages/crypto/             AES-256-GCM for secrets stored in the control plane
  packages/provisioner/        gives a vendor its Neon project (provisionVendor, and a script)
  apps/gateway/                the gateway Worker
    src/app.ts                 routes, validation, decisions
    src/store.ts               the gateway's SQL, over Neon's HTTP driver
    src/index.ts               Worker entry: fetch, and the 6-hourly cron
    test/                      routes with a fake store; the real SQL on in-memory Postgres
  .github/workflows/
    ci.yml                     typecheck, tests and a Worker bundle on every PR
    db-preview.yml             a Neon branch per pull request, migrated and diffed
    db-migrate.yml             migrates production after a merge to main
    gateway-deploy.yml         migrates, deploys the gateway and smoke-tests it
    provision-vendor.yml       provisions one vendor's Neon project, started by hand
```

## Neon

| | |
| --- | --- |
| Project | `neuvex-control` (`broad-heart-60441201`), AWS Singapore, Postgres 18 |
| Branches | `production` (live), `dev` (day-to-day work), `preview/pr-<n>` (one per pull request, expires after 7 days) |
| Database | `neondb` |

### Roles

Roles were created with SQL, not in the Neon Console, so they get only the rights granted below. Roles created in the Console or API become admins (`neon_superuser`).

| Role | Used by | Can do |
| --- | --- | --- |
| `neuvex_migrator` | CI | Create schemas; create and change tables in `control` |
| `neuvex_gateway` | The gateway Worker | Read primitives and contracts, write audit events and usage, run audit maintenance. Always limited to one vendor by row-level security |
| `neuvex_provisioner` | The Provision vendor workflow | Find a vendor by slug, read it, update only its provisioning columns, one vendor at a time |
| `waitlist_writer` | The `neuvex-waitlist` Cloudflare Worker | Insert into `public.waitlist`, nothing else |
| `neondb_owner` | People, in the Neon Console | Everything. Never put it in an app or CI |

The roles' grants live in migrations (0003 for the gateway, 0005 for the provisioner). Only the roles themselves are made by hand.

### One-time database setup (done 7 November 2026)

Run by hand on `production` before this repo existed: `CREATE SCHEMA control`, the roles above with database-generated passwords, and these grants:

```sql
GRANT CREATE ON DATABASE neondb TO neuvex_migrator;
GRANT USAGE, CREATE ON SCHEMA control TO neuvex_migrator;
GRANT INSERT ON public.waitlist TO waitlist_writer;
GRANT USAGE ON SEQUENCE public.waitlist_id_seq TO waitlist_writer;
```

Added for Phase 2, so migrations can grant the gateway access to `control` (the migrator doesn't own that schema, so it needs the right to pass its access on):

```sql
GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION;
```

Migration 0003 stops with a clear error if this is missing.

Added for Phase 3, before migration 0005 (which stops with a clear error without it). It creates the provisioner's role with a password generated by the database, and prints `role:password`:

```sql
CREATE OR REPLACE FUNCTION pg_temp.make_login(r text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pw text := 'Nx_' || replace(gen_random_uuid()::text, '-', '') || upper(substr(md5(random()::text), 1, 8));
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', r, pw);
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', r, pw);
  END IF;
  RETURN r || ':' || pw;
END $$;
SELECT pg_temp.make_login('neuvex_provisioner');
```

`migrations/0000_baseline.sql` records this starting point.

## GitHub Actions secrets

| Secret | Value |
| --- | --- |
| `NEON_API_KEY` | Neon API key scoped to `neuvex-control` |
| `NEON_PROJECT_ID` | `broad-heart-60441201` |
| `MIGRATOR_DATABASE_URL` | `neuvex_migrator` on production's direct (non-pooled) address |
| `GATEWAY_DATABASE_URL` | `neuvex_gateway` on production's pooled address. Becomes the Worker's `DATABASE_URL` secret on deploy |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from the "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID |
| `NEON_ORG_API_KEY` | Neon **organization** API key (can create projects). Used only by Provision vendor |
| `NEON_ORG_ID` | The Neon organization ID, `org-...` |
| `PROVISIONER_DATABASE_URL` | `neuvex_provisioner` on production's pooled address |
| `VENDOR_DB_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts vendor connection strings; the gateway gets the same key in part 2. Never change it without re-encrypting |

## How a database change ships

1. Edit or add a table in `packages/db/src/schema/` and re-export it from `tables.ts`.
2. Run `npm run db:generate -- --name=<what_changed>` and commit the new SQL file in `migrations/`.
3. Open a pull request. **Database preview** runs the tests, creates `preview/pr-<n>` from production, runs the migrations there as `neuvex_migrator`, and comments the schema diff on the PR.
4. Merge. **Database migrate (production)** applies the migration to production. The preview branch is deleted when the PR closes.

## How the gateway ships

Merging changes to `apps/gateway`, `packages/contracts` or the migrations runs **Gateway deploy**: it applies any pending migrations first (sharing a lock with Database migrate), then typechecks, tests, deploys the Worker with its `DATABASE_URL` secret, and smoke-tests the live URL. The smoke test calls `/v1/check` with a made-up key and expects `401`, which proves the Worker can reach Neon as `neuvex_gateway`.

To try it end to end, add the demo vendor and a key to production, then call the gateway:

```bash
DATABASE_URL='<MIGRATOR_DATABASE_URL>' npm run db:seed:demo -- --allow-production
DATABASE_URL='<MIGRATOR_DATABASE_URL>' npm run db:create-key -- inboxly-demo

curl -s https://neuvex-gateway.<subdomain>.workers.dev/v1/check \
  -H 'authorization: Bearer nvx_live_...' -H 'content-type: application/json' \
  -d '{"primitive":"email.list_messages","action":"read","data":[{"id":"m1","subject":"Hi","from":{"address":"ann@x.io"},"body":"secret"}]}'
```

## Commands

```bash
npm install
npm run db:generate -- --name=add_vendors   # write a migration from schema changes
npm run db:check                             # check migration files are consistent
npm test                                     # run all migrations on in-memory Postgres and test them
npm run db:migrate                           # apply migrations to DATABASE_URL
npm run db:seed:demo                         # add the demo vendor (refuses production without --allow-production)
npm run db:create-key -- <vendor-slug>       # make a vendor API key (add --scopes a,b to change scopes)
npm run gateway:dev                          # run the gateway locally (needs apps/gateway/.dev.vars with DATABASE_URL)
npm run provision -w @neuvex/provisioner -- <slug>   # provision a vendor (needs the four env vars in the script's header)
npm run typecheck
```

For local work, copy `.env.example` to `.env` and point `DATABASE_URL` at the `dev` branch, never production. Load it with `set -a; source .env; set +a` before running `db:migrate`.

## Troubleshooting

- **"Load failed" or "Failed to connect to the database endpoint" in the Neon Console on Jio networks.** Jio's DNS refuses Neon database hostnames. Set the Mac's DNS to `1.1.1.1` and `8.8.8.8` (System Settings, Wi-Fi, Details, DNS).
- **The production branch shows "Branch archived".** On the free plan Neon archives branches untouched for 24 hours once the project is 14 days old. The first query wakes it, which can take a minute. The gateway's 6-hourly cron keeps production awake once it is deployed.
- **Migration 0003 fails with "neuvex_gateway has no USAGE on schema control".** Run the `WITH GRANT OPTION` line from the one-time setup as `neondb_owner`, then rerun the workflow.
- **Gateway deploy's smoke test gets 500.** The Worker cannot query Neon: check `GATEWAY_DATABASE_URL` (role `neuvex_gateway`, pooled host) and that migration 0003 ran. Worker logs are under Workers & Pages, `neuvex-gateway`, Logs.
