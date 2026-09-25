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

- `scripts/cleanup-hampers-redis.ts [--dry-run]` — remove retired HAMPERS / legacy quota keys.
- `scripts/resync-quotas.ts` — recompute all upcoming daily + hourly quota counters from Postgres.

Run with `npx ts-node scripts/<name>.ts` (uses `.env`, i.e. production if that's what it points to).

## Docs

- `docs/plan-perbaikan-issue.md`, `docs/plan-stock-bahan-baku.md`, `docs/plan-implementasi-stock-bahan-baku.md`
- `docs/fase/` — per-phase checklists with what was done and what still needs a deploy step.
