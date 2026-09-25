// Deletes every daily/hourly quota counter in Redis (quota:*, hourly:*).
// Use after clearing daily_quota/hourly_quota/orders (scripts/clear-data.sql). Counters are
// rebuilt from Postgres automatically as soon as new quotas are created or read.
// With --caches it also drops the cached menu/variant lists (needed after clearing those tables).
// The WhatsApp session is never touched.
// Usage: npx ts-node scripts/clear-quota-redis.ts [--dry-run] [--caches]
import { redis } from '../src/utils/redis';

const PATTERNS = ['quota:*', 'hourly:*'];
const CACHE_KEYS = ['menu_list', 'variant_list', 'menu_list:v2', 'variant_list:v2', 'menu_list:v3', 'variant_list:v3'];

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    let total = 0;
    for (const match of PATTERNS) {
        let cursor: string | number = 0;
        do {
            const [next, keys]: [string | number, string[]] = await redis.scan(cursor, { match, count: 500 });
            cursor = next;
            if (keys.length > 0) {
                total += keys.length;
                if (!dryRun) await redis.del(...keys);
            }
        } while (String(cursor) !== '0');
    }
    if (process.argv.includes('--caches')) {
        const existing = (await redis.mget(...CACHE_KEYS)).filter(v => v !== null).length;
        total += existing;
        if (!dryRun) await redis.del(...CACHE_KEYS);
        console.log(`cache keys present: ${existing}`);
    }
    console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${total} key(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
