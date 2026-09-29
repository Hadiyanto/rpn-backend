#!/usr/bin/env bash
# Copies the RPN database (schema "public": every table, its data, sequences, indexes,
# constraints and the pgmigrations history) to a new, empty Postgres database.
#
#   TARGET_DATABASE_URL='postgresql://…' scripts/migrate-db.sh            # copy
#   TARGET_DATABASE_URL='postgresql://…' scripts/migrate-db.sh --dry-run  # check + dump only
#
# SOURCE_DATABASE_URL defaults to DATABASE_URL from .env. The source is only read (pg_dump).
# The dump is kept in backups/ as a backup of the source.
#
# user_roles.user_id references auth.users (Supabase login). That foreign key is restored only
# when the target has auth.users containing every user id; otherwise it is skipped (and said so),
# because the login users live in the Supabase project, not in this data.
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [[ -z "${SOURCE_DATABASE_URL:-}" && -f .env ]]; then
    SOURCE_DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'")"
fi
: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL (or DATABASE_URL in .env)}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the new database}"

mask() { sed -E 's#//([^:/@]+):[^@]*@#//\1:***@#' <<<"$1"; }
say() { printf '\n==> %s\n' "$*"; }
q() { psql "$1" -X -v ON_ERROR_STOP=1 -Atc "$2"; }

for bin in pg_dump pg_restore psql; do
    command -v "$bin" >/dev/null || { echo "$bin not found (brew install postgresql@17)" >&2; exit 1; }
done

say "Source: $(mask "$SOURCE_DATABASE_URL")"
say "Target: $(mask "$TARGET_DATABASE_URL")"
[[ "$SOURCE_DATABASE_URL" == "$TARGET_DATABASE_URL" ]] && { echo "Source and target are the same database." >&2; exit 1; }

# pg_dump must be at least the source server's major version.
SRC_MAJOR="$(q "$SOURCE_DATABASE_URL" 'SHOW server_version_num' | cut -c1-2)"
DUMP_MAJOR="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
TGT_MAJOR="$(q "$TARGET_DATABASE_URL" 'SHOW server_version_num' | cut -c1-2)"
echo "Postgres: source $SRC_MAJOR, target $TGT_MAJOR, pg_dump $DUMP_MAJOR"
(( DUMP_MAJOR >= SRC_MAJOR )) || { echo "pg_dump $DUMP_MAJOR is older than the source server ($SRC_MAJOR)." >&2; exit 1; }
(( TGT_MAJOR >= SRC_MAJOR )) || echo "Warning: target Postgres ($TGT_MAJOR) is older than the source ($SRC_MAJOR); restore may fail."

# Never overwrite: the target's public schema must have no tables.
EXISTING="$(q "$TARGET_DATABASE_URL" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if (( EXISTING > 0 )); then
    echo "Target already has $EXISTING table(s) in schema public. Use an empty database (nothing was changed)." >&2
    exit 1
fi

TABLES="$(q "$SOURCE_DATABASE_URL" "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")"
say "Source tables ($(wc -l <<<"$TABLES" | tr -d ' ')):"
echo "$TABLES" | tr '\n' ' '; echo

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="backups/migrate-$STAMP.dump"
say "Dumping schema public → $DUMP"
pg_dump "$SOURCE_DATABASE_URL" --format=custom --schema=public --no-owner --no-privileges --file="$DUMP"
ls -lh "$DUMP" | awk '{print "   size " $5}'

# Decide about the auth.users foreign key.
LIST="backups/migrate-$STAMP.list"
trap 'rm -f "$LIST" "$LIST.use"' EXIT
pg_restore --list "$DUMP" > "$LIST"
AUTH_FKS="$(grep -E 'FK CONSTRAINT public user_roles ' "$LIST" || true)"
SKIP_AUTH_FK=0
if [[ -n "$AUTH_FKS" ]]; then
    HAS_AUTH="$(q "$TARGET_DATABASE_URL" "SELECT to_regclass('auth.users') IS NOT NULL")"
    if [[ "$HAS_AUTH" != "t" ]]; then
        SKIP_AUTH_FK=1
        echo "Target has no auth.users → user_roles → auth.users foreign key will be skipped."
    else
        IDS="$(q "$SOURCE_DATABASE_URL" "SELECT coalesce(string_agg(quote_literal(user_id::text), ','), '') FROM user_roles")"
        if [[ -n "$IDS" ]]; then
            MISSING="$(q "$TARGET_DATABASE_URL" "SELECT count(*) FROM unnest(ARRAY[$IDS]::uuid[]) id WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = id)")"
            if (( MISSING > 0 )); then
                SKIP_AUTH_FK=1
                echo "$MISSING user_roles user(s) are not in the target's auth.users → that foreign key will be skipped."
            fi
        fi
    fi
fi
# The target already has schema public (every database does); don't recreate or re-comment it.
SKIP_PATTERN=' SCHEMA - public | COMMENT - SCHEMA public '
(( SKIP_AUTH_FK )) && SKIP_PATTERN="$SKIP_PATTERN|FK CONSTRAINT public user_roles "
grep -vE "$SKIP_PATTERN" "$LIST" > "$LIST.use"

if (( DRY_RUN )); then
    say "Dry run: nothing restored. Dump kept at $DUMP."
    exit 0
fi

say "Preparing target (extensions used by the schema)"
q "$TARGET_DATABASE_URL" 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' >/dev/null

say "Restoring (one transaction: on any error the target stays empty)"
# Through SQL + psql so settings newer than the target server (e.g. PG17's transaction_timeout)
# can be dropped; everything else is restored exactly as dumped.
pg_restore --no-owner --no-privileges --use-list="$LIST.use" --file=- "$DUMP" \
    | sed -E '/^SET transaction_timeout = /d' \
    | psql "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null

say "Verifying row counts"
FAIL=0
printf '   %-28s %10s %10s\n' table source target
while read -r t; do
    [[ -z "$t" ]] && continue
    s="$(q "$SOURCE_DATABASE_URL" "SELECT count(*) FROM public.\"$t\"")"
    d="$(q "$TARGET_DATABASE_URL" "SELECT count(*) FROM public.\"$t\"")"
    mark=""; [[ "$s" != "$d" ]] && { mark="  ✗"; FAIL=1; }
    printf '   %-28s %10s %10s%s\n' "$t" "$s" "$d" "$mark"
done <<<"$TABLES"

SRC_MIG="$(q "$SOURCE_DATABASE_URL" 'SELECT max(name) FROM pgmigrations')"
TGT_MIG="$(q "$TARGET_DATABASE_URL" 'SELECT max(name) FROM pgmigrations')"
echo "   last migration: source $SRC_MIG, target $TGT_MIG"
[[ "$SRC_MIG" != "$TGT_MIG" ]] && FAIL=1

if (( FAIL )); then
    echo "Verification FAILED: counts differ (see ✗ above)." >&2
    exit 1
fi

say "Done. All tables match."
(( SKIP_AUTH_FK )) && echo "   Note: user_roles is not linked to auth.users on the target (logins stay in the Supabase project)."
cat <<'EOF'

Next steps:
  1. Point DATABASE_URL to the new database (Render env + rpn-backend/.env), then redeploy.
  2. `npm run migrate up` against it should report no pending migrations.
  3. Reset Redis (quota counters + menu/variant caches; they are rebuilt from the new DB):
       npx ts-node scripts/clear-quota-redis.ts --caches --dry-run   # check, then without --dry-run
  4. Keep the old database until the app has run fine on the new one.
EOF
