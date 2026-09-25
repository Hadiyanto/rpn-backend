// Deletes every daily/hourly quota counter in Redis (quota:*, hourly:*).
// Use after clearing daily_quota/hourly_quota/orders (scripts/clear-data.sql). Counters are
// rebuilt from Postgres automatically as soon as new quotas are created or read.
// The WhatsApp session and menu/variant caches are NOT touched.
// Usage: npx ts-node scripts/clear-quota-redis.ts [--dry-run]
import { redis } from '../src/utils/redis';

const PATTERNS = ['quota:*', 'hourly:*'];

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
    console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${total} key(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
