// Recomputes every upcoming daily + hourly Redis quota counter from Postgres.
// Run once after deploying Fase 02 to correct values written by the old HALF=1 sync.
// Usage: npx ts-node scripts/resync-quotas.ts
import { pool } from '../src/config/db';
import { syncDailyRedisQuota } from '../src/services/dailyQuota.service';
import { syncHourlyRedisQuota } from '../src/services/hourlyQuota.service';
import { todayWIB } from '../src/utils/validation';

async function main() {
    const { rows } = await pool.query(
        'SELECT store_id, date::text AS date FROM daily_quota WHERE date >= $1::date ORDER BY store_id, date',
        [todayWIB()]
    );

    for (const { store_id, date } of rows) {
        await syncDailyRedisQuota(store_id, date);
        await syncHourlyRedisQuota(date, store_id);
        console.log(`synced store ${store_id} ${date}`);
    }

    console.log(`Done: ${rows.length} date(s).`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
