import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('CRITICAL: DATABASE_URL environment variable is missing!');
}

export const pool = new Pool({
    connectionString,
    max: 100, // Increase max connections significantly for overlapping deployments
    idleTimeoutMillis: 10000, // Close idle connections after 10 seconds
    connectionTimeoutMillis: 30000, // Wait max 30 seconds before failing to connect
    statement_timeout: 30000, // Kill any query taking longer than 30 seconds to free connection
    keepAlive: true, // Prevent proxy from silently dropping connections
    ssl: { rejectUnauthorized: false }, // Required by some cloud DB platforms including Supabase
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
