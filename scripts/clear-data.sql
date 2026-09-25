-- Clears transactional data and editable configuration, keeping users and master data.
--
-- RUN ONLY AFTER:
--   1. Backup:  npx ts-node scripts/backup-csv.ts
--               pg_dump "$DATABASE_URL" -Fc -f backups/rpn-before-clear.dump
--   2. All migrations are applied (npm run migrate up) — this script references new tables.
-- THEN:
--   3. npx ts-node scripts/clear-quota-redis.ts   (drop the now-stale quota counters)
--
-- KEPT: auth.users, user_roles, push_subscriptions, pgmigrations, health,
--       stores, menu, variant, variant_components (no UI exists to recreate stores/menu/variants).
--
-- No CASCADE: TRUNCATE fails instead of silently wiping a table that isn't listed here.
-- No RESTART IDENTITY: ids keep counting up, so an old WhatsApp link like /bukti-transfer/12
-- can never open a NEW customer's order that happens to get id 12.

BEGIN;

-- One statement: these tables reference each other (stock_history → stock and → orders,
-- order_items → orders, penjualan → transactions, variant_recipe → stock), so they must be
-- truncated together.
TRUNCATE TABLE
    -- Orders (and the stock movements they caused)
    order_item_variants, order_items, stock_history, orders,
    -- Stock & recipes
    variant_recipe, stock,
    -- Finance & POS
    penjualan, transactions, pengeluaran, capital, debt, daily_salary,
    -- Editable configuration (recreate in /config and /config/salary)
    daily_quota, hourly_quota, salary_config;

-- Sanity check before committing: every cleared table must be empty now.
SELECT 'orders' AS t, count(*) FROM orders
UNION ALL SELECT 'stock', count(*) FROM stock
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'daily_quota', count(*) FROM daily_quota
UNION ALL SELECT 'stores (kept)', count(*) FROM stores
UNION ALL SELECT 'menu (kept)', count(*) FROM menu
UNION ALL SELECT 'variant (kept)', count(*) FROM variant
UNION ALL SELECT 'user_roles (kept)', count(*) FROM user_roles;

COMMIT;
