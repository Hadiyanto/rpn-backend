import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
    console.warn("Upstash Redis credentials are not fully configured in environment variables.");
}

export const redis = new Redis({
    url: url || '',
    token: token || '',
    retry: {
        retries: 3,
        backoff: (retryCount) => Math.exp(retryCount) * 50,
    }
});

// TTL (seconds) so a date-scoped quota key self-expires a few days after its
// date passes, instead of lingering in Redis forever with no expiry.
export function ttlUntilDate(date: string, bufferDays = 3): number {
    const expiresAt = new Date(`${date}T00:00:00`);
    expiresAt.setDate(expiresAt.getDate() + bufferDays);
    const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    return Math.max(seconds, 86400);
}
