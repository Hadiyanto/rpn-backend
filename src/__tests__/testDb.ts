// Helpers for integration tests that need a real Postgres.
// They only run when TEST_DATABASE_URL points at localhost — never at Supabase.
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasTestDb = /^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(TEST_DB_URL);

/** Must be called before importing anything that loads src/config/db. */
export const useTestDb = () => {
    if (!hasTestDb) throw new Error('TEST_DATABASE_URL must point to a local Postgres');
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.PG_SSL = 'false';
    // Safety net: never let a test reach the real Upstash instance from .env.
    // (dotenv does not override variables that are already set.) Tests that need Redis mock it.
    process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
    // Same for Supabase: any code path still on supabase-js must fail, not read production.
    process.env.SUPABASE_URL = 'http://127.0.0.1:1';
    process.env.SUPABASE_KEY = 'test';
};
