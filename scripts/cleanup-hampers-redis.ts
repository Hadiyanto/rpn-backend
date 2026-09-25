// One-off cleanup after removing HAMPERS: deletes quota:hampers:* and hourly:hampers:* keys.
// Also removes legacy quota keys written without a store_id (quota:YYYY-MM-DD).
// Usage: npx ts-node scripts/cleanup-hampers-redis.ts [--dry-run]
import { redis } from '../src/utils/redis';

// Legacy keys look like quota:2026-02-26 — match the exact date shape so current
// per-store keys (quota:<store_id>:<date>) are never touched, even for store_id >= 20.
const PATTERNS = [
    'quota:hampers:*',
    'hourly:hampers:*',
    'quota:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',
];

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
                console.log(`${dryRun ? '[dry-run] ' : ''}${match}: ${keys.length} key(s)`);
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
