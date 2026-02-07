import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

dotenv.config();

const url = process.env.UPSTASH_REDIS_REST_URL || '';
const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';

if (!url || !token) {
    console.warn('Upstash Redis URL or Token is missing from environment variables.');
}

export const redis = new Redis({
    url: url,
    token: token,
});
