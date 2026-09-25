import { pool, insertRow } from '../config/db';
import { redis, ttlUntilDate } from '../utils/redis';
import { BOX_UNITS_SQL, remainingQuota } from '../utils/boxUnits';
import { ValidationError } from '../utils/validation';
import { redisKeys } from '../utils/redisKeys';
import { NotFoundError } from '../utils/errors';

const dailyKey = redisKeys.dailyQuota;

/** Box units already taken by non-cancelled orders, per pickup date. Dates without orders are 0. */
export const getUsedBoxByDate = async (store_id: number, dates: string[]): Promise<Map<string, number>> => {
    const used = new Map<string, number>(dates.map(d => [d, 0]));
    if (dates.length === 0) return used;

    const res = await pool.query(`
        SELECT o.pickup_date::text AS date, COALESCE(SUM(${BOX_UNITS_SQL}), 0) AS used_qty
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.store_id = $1
          AND o.pickup_date = ANY($2::date[])
          AND o.status != 'CANCELLED'
        GROUP BY o.pickup_date
    `, [store_id, dates]);

    for (const row of res.rows) {
        used.set(row.date, parseFloat(row.used_qty));
    }
    return used;
};

/**
 * Resolves "remaining" for each quota row: Redis is the live source of truth; on a cache
 * miss the value is rebuilt from DB (qty − used) and written back with NX so a concurrent
 * createOrder() decrement is never clobbered.
 */
const withRemaining = async <T extends { date: string; qty: string | number }>(store_id: number, rows: T[]) => {
    const keys = rows.map(row => dailyKey(store_id, row.date));
    const redisVals: (string | number | null)[] = keys.length > 0 ? await redis.mget(...keys) : [];

    const missingDates = rows.filter((_, i) => redisVals[i] === null || redisVals[i] === undefined).map(r => r.date);
    const usedByDate = await getUsedBoxByDate(store_id, missingDates);

    return rows.map((row, i) => {
        const qty = parseFloat(String(row.qty));
        const key = dailyKey(store_id, row.date);
        const rQty = redisVals[i];
        let remaining_qty: number;

        if (rQty !== null && rQty !== undefined) {
            remaining_qty = Math.max(0, Number(rQty));
            if (qty < remaining_qty) {
                remaining_qty = Math.max(0, qty);
                redis.set(key, remaining_qty, { ex: ttlUntilDate(row.date) }).catch(console.error);
            }
        } else {
            remaining_qty = remainingQuota(qty, usedByDate.get(row.date) ?? 0);
            redis.set(key, remaining_qty, { nx: true, ex: ttlUntilDate(row.date) }).catch(console.error);
        }

        return {
            ...row,
            qty,
            used_qty: Math.max(0, qty - remaining_qty),
            remaining_qty,
        };
    });
};

export const getDailyQuotas = async (store_id: number) => {
    // DB is needed for the master 'qty' (total provisioned limit) and 'id' mappings
    const { rows } = await pool.query(
        'SELECT id, date, qty, store_id FROM daily_quota WHERE store_id = $1 ORDER BY date DESC LIMIT 30',
        [store_id]
    );
    return withRemaining(store_id, rows);
};

export const getDailyQuotaByDate = async (date: string, store_id: number) => {
    const { rows } = await pool.query(
        'SELECT id, date, qty, store_id FROM daily_quota WHERE date = $1::date AND store_id = $2 LIMIT 1',
        [date, store_id]
    );
    if (rows.length === 0) return null;

    const [row] = await withRemaining(store_id, rows);
    return row;
};

/**
 * Makes sure the Redis counter for a date exists before createOrder() decrements it.
 * Without this, INCRBYFLOAT on a missing key starts from 0, rejects the order as "full",
 * and leaves a TTL-less "0" key behind that NX warming can never repair.
 */
export const ensureDailyQuotaKey = async (store_id: number, date: string) => {
    const key = dailyKey(store_id, date);
    if (await redis.exists(key)) return;

    const dqRes = await pool.query('SELECT qty FROM daily_quota WHERE store_id = $1 AND date = $2::date', [store_id, date]);
    if (dqRes.rowCount === 0) {
        throw new ValidationError(`MOHON MAAF: Tanggal ${date} belum dibuka untuk pemesanan.`);
    }

    const used = (await getUsedBoxByDate(store_id, [date])).get(date) ?? 0;
    await redis.set(key, remainingQuota(parseFloat(dqRes.rows[0].qty), used), { nx: true, ex: ttlUntilDate(date) });
};

export const createDailyQuota = async (date: string, qty: number, store_id: number) => {
    // A duplicate (store_id, date) raises pg error 23505, which the route turns into a 400.
    const data = await insertRow('daily_quota', { date, qty, store_id });

    // Orders may already exist for this date (e.g. the quota row was deleted and re-created),
    // so compute remaining from DB instead of assuming the full qty is free.
    await syncDailyRedisQuota(store_id, date);

    return data;
};

export const updateDailyQuota = async (id: number, qty: number) => {
    const { rows: [data] } = await pool.query(
        'UPDATE daily_quota SET qty = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
        [id, qty]
    );
    if (!data) throw new NotFoundError(`Kuota dengan id ${id} tidak ditemukan`);

    // Sync the updated quota to Redis
    // Calculate the real remaining qty by querying PostgreSQL exactly how many were already sold.
    if (data && data.date) {
        await syncDailyRedisQuota(data.store_id, data.date);
    }

    return data;
};

export const deleteDailyQuota = async (id: number) => {
    // Determine the date/store to delete the keys from Redis
    const { rows: [qData] } = await pool.query('DELETE FROM daily_quota WHERE id = $1 RETURNING date, store_id', [id]);

    if (qData && qData.date) {
        try {
            await redis.del(dailyKey(qData.store_id, qData.date));
        } catch (err) {
            console.error(`Failed to delete Redis quota keys for store ${qData.store_id}, date: ${qData.date}`, err);
        }
    }

    return true;
};

export const syncDailyRedisQuota = async (store_id: number, date: string) => {
    try {
        const dqRes = await pool.query('SELECT qty FROM daily_quota WHERE store_id = $1 AND date = $2::date', [store_id, date]);
        if (dqRes.rowCount === 0) return;

        const used = (await getUsedBoxByDate(store_id, [date])).get(date) ?? 0;
        const newRemaining = remainingQuota(parseFloat(dqRes.rows[0].qty), used);

        await redis.set(dailyKey(store_id, date), newRemaining, { ex: ttlUntilDate(date) });
    } catch (err) {
        console.error(`Failed to sync updated daily quota to Redis for store ${store_id}, date: ${date}`, err);
    }
};
