import { Pool, PoolClient, types } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Return DATE columns as plain 'YYYY-MM-DD' strings (what supabase-js returns) instead of
// JS Date objects at server-local midnight, which serialize to shifted ISO timestamps.
types.setTypeParser(types.builtins.DATE, (value) => value);
// Return NUMERIC as a JS number (what supabase-js returns) instead of a string, so moving a
// query from supabase-js to pg keeps the same response shape. All our numerics are
// quantities/money well within double precision.
types.setTypeParser(types.builtins.NUMERIC, (value) => parseFloat(value));
// TIMESTAMP (without time zone): keep supabase-js' "YYYY-MM-DDTHH:mm:ss.ffffff" string instead
// of a Date built in the server's local zone, so the frontend parses it exactly as before.
types.setTypeParser(types.builtins.TIMESTAMP, (value) => value.replace(' ', 'T'));

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('CRITICAL: DATABASE_URL environment variable is missing!');
}

export const pool = new Pool({
    connectionString,
    // Supabase's pooler caps connections per client far below 100; 10 is plenty for this app.
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 10000, // Close idle connections after 10 seconds
    connectionTimeoutMillis: 30000, // Wait max 30 seconds before failing to connect
    statement_timeout: 30000, // Kill any query taking longer than 30 seconds to free connection
    keepAlive: true, // Prevent proxy from silently dropping connections
    // Required by some cloud DB platforms including Supabase. PG_SSL=false for a local Postgres (tests).
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Catch pool errors so idle connection terminations don't crash the Node application
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle database client', err);
});

// Generic transaction wrapper that provides a safe PoolClient
export const transaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Drops undefined values, like supabase-js did when serializing insert/update payloads —
 * so "field not sent" keeps meaning "leave the column alone / use its default".
 */
const definedEntries = (values: Record<string, unknown>) =>
    Object.entries(values).filter(([, v]) => v !== undefined);

/** INSERT … RETURNING *. Table and column names must come from code, never from user input. */
export const insertRow = async <T = any>(table: string, values: Record<string, unknown>, db: Queryable = pool): Promise<T> => {
    const entries = definedEntries(values);
    if (entries.length === 0) {
        const { rows } = await db.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`);
        return rows[0];
    }
    const cols = entries.map(([k]) => k).join(', ');
    const params = entries.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await db.query(`INSERT INTO ${table} (${cols}) VALUES (${params}) RETURNING *`, entries.map(([, v]) => v));
    return rows[0];
};

/** UPDATE … WHERE id = $1 RETURNING * (undefined when no row matched). Names must come from code. */
export const updateRowById = async <T = any>(table: string, id: number, values: Record<string, unknown>, db: Queryable = pool): Promise<T | undefined> => {
    const entries = definedEntries(values);
    if (entries.length === 0) {
        const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
        return rows[0];
    }
    const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await db.query(`UPDATE ${table} SET ${set} WHERE id = $1 RETURNING *`, [id, ...entries.map(([, v]) => v)]);
    return rows[0];
};
