# rpn-backend

Express + TypeScript API for Raja Pisang Nugget: orders, daily/hourly quota, stock & recipes (HPP,
automatic deduction), finance, salary, WhatsApp notifications and Biteship delivery.

- **Postgres** (Supabase) via `pg` — all data access (`src/config/db.ts`).
- **Upstash Redis** — live quota counters, WhatsApp session, menu/variant cache.
- Frontend: `../rpn-frontend` (Next.js). Supabase is only used there for login.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev            # nodemon + ts-node on src/index.ts
```

Build & run like production: `npm run build && npm start`.

## Database migrations

Migrations live in `migrations/` (node-pg-migrate) and are **not** run on deploy.

```bash
npm run migrate up      # apply pending migrations to DATABASE_URL from .env
npm run migrate down 1  # roll back the last one
```

When a release needs both code and schema changes, follow the order described in
`docs/fase/README.md` ("Urutan deploy").

## Tests

```bash
npm test          # unit tests only (no database)
npm run test:db   # + integration tests against a LOCAL Postgres
```

Integration tests only run when `TEST_DATABASE_URL` points at localhost (default
`postgres://localhost/rpn_migration_test`). They override Supabase/Upstash env vars with dead
addresses and mock Redis, WhatsApp, Biteship and web-push, so they can never touch production.
One-time setup:

```bash
createdb rpn_migration_test
psql rpn_migration_test -c "CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);"
DATABASE_URL=postgres://localhost/rpn_migration_test node node_modules/.bin/node-pg-migrate up
```

## Scripts

- `scripts/resync-quotas.ts` — recompute all upcoming daily + hourly quota counters from Postgres.
- `scripts/clear-quota-redis.ts [--dry-run] [--caches]` — delete RPN quota counters (and cached menu/variant lists).
- `scripts/backup-csv.ts` — read-only CSV export of every table into `backups/` (gitignored).

Run with `npx ts-node scripts/<name>.ts` (uses `.env`, i.e. production if that's what it points to).

## Database backup (pg-backup)

`tools/db-backup/` — a container that `pg_dump`s the database (`DOCKER_DATABASE_URL`) every hour into
`backups/` and a **private** Cloudflare R2 bucket, optionally restoring each backup into Supabase.
Configure it in `tools/db-backup/.env` (copy `.env.example`), then on the server:

```bash
docker compose --profile backup up -d --build pg-backup   # hourly backups
docker compose run --rm pg-backup once                    # one backup now
docker compose run --rm pg-backup r2-list                 # backups in R2
docker compose run --rm pg-backup r2-get backups/2026/10/<file>.dump
docker compose run --rm pg-backup restore /backups/<file>.dump <postgres-url>
```

Local backups older than `BACKUP_KEEP_DAYS` (14) are deleted, keeping the latest 3; expiry in R2 is a
lifecycle rule on the bucket. A restore runs in one transaction and refuses to target the source DB.

## Redis keys

The Upstash instance is **shared with other apps**, so every RPN key lives under `rpn:` and is
built in `src/utils/redisKeys.ts` (never write key strings inline). Scripts only scan `rpn:*` patterns.

| Key | Holds | TTL |
|---|---|---|
| `rpn:quota:daily:{storeId}:{YYYY-MM-DD}` | remaining box units that day (HALF = 0.5) | a few days after the date |
| `rpn:quota:hourly:{storeId}:{YYYY-MM-DD}:{HH}` | remaining box units in that hour slot | same |
| `rpn:cache:menu:v{n}` / `rpn:cache:variants:v{n}` | cached `GET /menu`, `GET /variants` | 30 days, deleted on change |
| `rpn:wa:main:{type}` | WhatsApp (Baileys) auth state | none |

Bump the cache version when the cached row shape changes. The WhatsApp session used to live under
`rpn-wa-session:*`; it is renamed to `rpn:wa:main:*` automatically on first start (RENAMENX, idempotent).

## Docs

- `docs/plan-perbaikan-issue.md`, `docs/plan-stock-bahan-baku.md`, `docs/plan-implementasi-stock-bahan-baku.md`
- `docs/fase/` — per-phase checklists with what was done and what still needs a deploy step.
