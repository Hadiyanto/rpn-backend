import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('CRITICAL: DATABASE_URL environment variable is missing!');
}

export const pool = new Pool({
    connectionString,
    max: 20, // Increase max connections due to deployment overlapping
    idleTimeoutMillis: 10000, // Close idle connections after 10 seconds
    connectionTimeoutMillis: 5000, // Wait max 5 seconds before failing to connect
    ssl: { rejectUnauthorized: false }, // Required by some cloud DB platforms including Supabase
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
