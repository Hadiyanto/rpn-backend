import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('CRITICAL: DATABASE_URL environment variable is missing!');
}

export const pool = new Pool({
    connectionString,
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
