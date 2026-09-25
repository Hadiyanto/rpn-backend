import { pool, transaction } from '../config/db';
import { redis, ttlUntilDate } from '../utils/redis';
import { BOX_UNITS_SQL, remainingQuota } from '../utils/boxUnits';
import { todayWIB } from '../utils/validation';

export interface HourlyQuota {
    id: number;
    time_str: string;
    qty: number;
    is_active: boolean;
    store_id: number;
}

export const getHourlyQuotas = async (store_id: number): Promise<HourlyQuota[]> => {
    const { rows } = await pool.query(
        'SELECT id, time_str, qty, is_active, store_id FROM hourly_quota WHERE store_id = $1 ORDER BY time_str ASC',
        [store_id]
    );

    return rows.map(row => ({
        ...row,
        qty: parseInt(row.qty, 10),
        is_active: row.is_active
    }));
};

export const getHourlyAvailability = async (date: string, store_id: number): Promise<(HourlyQuota & { used_qty: number, remaining_qty: number })[]> => {
    const { rows } = await pool.query(
        'SELECT id, time_str, qty, is_active, store_id FROM hourly_quota WHERE store_id = $1 ORDER BY time_str ASC',
        [store_id]
    );

    // Fetch all Redis keys at once for this date's time slots
    const keys = rows.map(row => `hourly:${store_id}:${date}:${row.time_str}`);

    let redisVals: (string | number | null)[] = [];
    if (keys.length > 0) {
        redisVals = await redis.mget(...keys);
    }

    // Check for cache miss. If ANY value is null, we must calculate from DB.
    let hasCacheMiss = false;
    for (const val of redisVals) {
        if (val === null || val === undefined) {
            hasCacheMiss = true;
            break;
        }
    }

    // If cache miss, calculate DB usage and save to Redis, then refetch Redis.
    if (hasCacheMiss) {
        await syncHourlyRedisQuota(date, store_id); // This runs the heavy PG query ONCE
        redisVals = await redis.mget(...keys); // Refetch fresh values
    }

    return rows.map((row, i) => {
        const qty = parseFloat(row.qty);

        let remaining_qty = qty;

        const rQty = redisVals[i];

        if (rQty !== null && rQty !== undefined) {
            remaining_qty = Math.max(0, Number(rQty));
        }

        const used_qty = Math.max(0, qty - remaining_qty);

        return {
            ...row,
            qty,
            used_qty,
            is_active: row.is_active,
            remaining_qty,
        };
    });
};

// Write operations still use transaction for data integrity
export const upsertHourlyQuota = async (time_str: string, qty: number, store_id: number, is_active: boolean = true) => {
    const res = await transaction(async (client) => {
        return client.query(`
            INSERT INTO hourly_quota (time_str, qty, is_active, store_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (store_id, time_str) DO UPDATE
            SET qty = EXCLUDED.qty, is_active = EXCLUDED.is_active, updated_at = current_timestamp
            RETURNING *
        `, [time_str, qty, is_active, store_id]);
    });

    // Recompute the per-date remaining counters for every upcoming date of this store,
    // otherwise a changed slot capacity only shows up once the old keys expire.
    try {
        const datesRes = await pool.query(
            'SELECT date::text AS date FROM daily_quota WHERE store_id = $1 AND date >= $2::date',
            [store_id, todayWIB()]
        );
        for (const { date } of datesRes.rows) {
            await syncHourlyRedisQuota(date, store_id);
        }
    } catch (err) {
        console.error('Failed to resync hourly quota in Redis after upsert', err);
    }

    return res.rows[0];
};

export const deleteHourlyQuota = async (id: number) => {
    await transaction(async (client) => {
        return client.query('DELETE FROM hourly_quota WHERE id = $1', [id]);
    });
    return true;
};

export const syncHourlyRedisQuota = async (date: string, store_id: number) => {
    try {
        const res = await pool.query(`
            SELECT
                hq.time_str,
                hq.qty,
                COALESCE(SUM(${BOX_UNITS_SQL}), 0) as used_qty
            FROM hourly_quota hq
            LEFT JOIN orders o ON o.pickup_date = $1 AND o.store_id = hq.store_id AND o.pickup_time LIKE (substring(hq.time_str, 1, 2) || '%') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE hq.store_id = $2
            GROUP BY hq.time_str, hq.qty
        `, [date, store_id]);

        for (const row of res.rows) {
            const rQty = remainingQuota(parseFloat(row.qty), parseFloat(row.used_qty));

            const ex = ttlUntilDate(date);
            await redis.set(`hourly:${store_id}:${date}:${row.time_str}`, rQty, { ex });
        }
    } catch (err) {
        console.error(`Failed to sync hourly Redis quotas for store ${store_id}, date: ${date}`, err);
    }
};
