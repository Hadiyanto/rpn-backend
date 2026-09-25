// Deletes RPN's quota counters (rpn:quota:*) and, with --caches, the cached menu/variant lists
// (rpn:cache:*). Only keys inside the rpn: namespace are touched — the Redis instance is shared
// with other apps. The WhatsApp session (rpn:wa:*) is never touched.
// Counters are rebuilt from Postgres automatically when quotas are created or read.
// --legacy also deletes keys from before the rpn: namespace existed (quota:*, hourly:*, menu_list*,
// variant_list*). ONLY use it on a Redis instance that holds nothing but RPN data — those patterns
// could match another app's keys on a shared instance. Always run with --dry-run first.
// Usage: npx ts-node scripts/clear-quota-redis.ts [--dry-run] [--caches] [--legacy]
import { redis } from '../src/utils/redis';
import { redisPatterns } from '../src/utils/redisKeys';

const LEGACY_PATTERNS = ['quota:*', 'hourly:*', 'menu_list*', 'variant_list*'];

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const patterns = [
        redisPatterns.quota,
        ...(process.argv.includes('--caches') ? [redisPatterns.cache] : []),
        ...(process.argv.includes('--legacy') ? LEGACY_PATTERNS : []),
    ];
    let total = 0;
    for (const match of patterns) {
        let found = 0;
        let cursor: string | number = 0;
        do {
            const [next, keys]: [string | number, string[]] = await redis.scan(cursor, { match, count: 500 });
            cursor = next;
            if (keys.length > 0) {
                total += keys.length;
                found += keys.length;
                if (!dryRun) await redis.del(...keys);
            }
        } while (String(cursor) !== '0');
        console.log(`${match}: ${found} key(s)`);
    }
    console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${total} key(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
