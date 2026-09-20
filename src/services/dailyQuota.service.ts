import { supabase } from '../config/supabase';
import { pool } from '../config/db';
import { redis, ttlUntilDate } from '../utils/redis';

export const getDailyQuotas = async (store_id: number) => {
    // DB is needed for the master 'qty' (total provisioned limit) and 'id' mappings
    const { data: rows, error } = await supabase
        .from('daily_quota')
        .select('id, date, qty, hampers_qty, store_id')
        .eq('store_id', store_id)
        .order('date', { ascending: false })
        .limit(30);

    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    const validRows = rows || [];

    const keys = validRows.flatMap(row => [`quota:${store_id}:${row.date}`, `quota:hampers:${store_id}:${row.date}`]);
    let redisVals: (string | number | null)[] = [];
    if (keys.length > 0) {
        redisVals = await redis.mget(...keys);
    }

    return validRows.map((row, i) => {
        const qty = parseFloat(row.qty);
        const hampers_qty = parseFloat(row.hampers_qty || '0');

        let remaining_qty = qty;
        let remaining_hampers_qty = hampers_qty;

        // Redis is the ultimate source of truth for "Remaining"
        const rQty = redisVals[i * 2];
        const rHampersQty = redisVals[i * 2 + 1];

        if (rQty !== null && rQty !== undefined) {
            remaining_qty = Math.max(0, Number(rQty));
            if (qty < remaining_qty) {
                remaining_qty = Math.max(0, qty);
                redis.set(`quota:${store_id}:${row.date}`, remaining_qty, { ex: ttlUntilDate(row.date) }).catch(console.error);
            }
        } else {
            // Cache warming if Redis dropped it. NX avoids clobbering a decrement
            // that a concurrent createOrder() call may have just applied.
            redis.set(`quota:${store_id}:${row.date}`, remaining_qty, { nx: true, ex: ttlUntilDate(row.date) }).catch(console.error);
        }

        if (rHampersQty !== null && rHampersQty !== undefined) {
            remaining_hampers_qty = Math.max(0, Number(rHampersQty));
            if (hampers_qty < remaining_hampers_qty) {
                remaining_hampers_qty = Math.max(0, hampers_qty);
                redis.set(`quota:hampers:${store_id}:${row.date}`, remaining_hampers_qty, { ex: ttlUntilDate(row.date) }).catch(console.error);
            }
        } else {
            // Cache warming (NX — see above)
            redis.set(`quota:hampers:${store_id}:${row.date}`, remaining_hampers_qty, { nx: true, ex: ttlUntilDate(row.date) }).catch(console.error);
        }

        const used_qty = Math.max(0, qty - remaining_qty);
        const used_hampers_qty = Math.max(0, hampers_qty - remaining_hampers_qty);

        return {
            ...row,
            qty,
            used_qty,
            remaining_qty,
            hampers_qty,
            used_hampers_qty,
            remaining_hampers_qty
        };
    });
};

export const getDailyQuotaByDate = async (date: string, store_id: number) => {
    const { data: rows, error } = await supabase
        .from('daily_quota')
        .select('id, date, qty, hampers_qty, store_id')
        .eq('date', date)
        .eq('store_id', store_id)
        .limit(1);

    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    if (!rows || rows.length === 0) return null;

    const row = rows[0];
    const qty = parseFloat(row.qty);
    const hampers_qty = parseFloat(row.hampers_qty || '0');

    let remaining_qty = qty;
    let remaining_hampers_qty = hampers_qty;

    // Redis overrides DB for live counts
    const rQty = await redis.get(`quota:${store_id}:${date}`);
    const rHampersQty = await redis.get(`quota:hampers:${store_id}:${date}`);

    if (rQty !== null && rQty !== undefined) {
        remaining_qty = Math.max(0, Number(rQty));
        if (qty < remaining_qty) {
            remaining_qty = Math.max(0, qty);
            redis.set(`quota:${store_id}:${date}`, remaining_qty, { ex: ttlUntilDate(date) }).catch(console.error);
        }
    } else {
        redis.set(`quota:${store_id}:${date}`, remaining_qty, { nx: true, ex: ttlUntilDate(date) }).catch(console.error);
    }

    if (rHampersQty !== null && rHampersQty !== undefined) {
        remaining_hampers_qty = Math.max(0, Number(rHampersQty));
        if (hampers_qty < remaining_hampers_qty) {
            remaining_hampers_qty = Math.max(0, hampers_qty);
            redis.set(`quota:hampers:${store_id}:${date}`, remaining_hampers_qty, { ex: ttlUntilDate(date) }).catch(console.error);
        }
    } else {
        redis.set(`quota:hampers:${store_id}:${date}`, remaining_hampers_qty, { nx: true, ex: ttlUntilDate(date) }).catch(console.error);
    }

    const used_qty = Math.max(0, qty - remaining_qty);
    const used_hampers_qty = Math.max(0, hampers_qty - remaining_hampers_qty);

    return {
        ...row,
        qty,
        used_qty,
        remaining_qty,
        hampers_qty,
        used_hampers_qty,
        remaining_hampers_qty
    };
};

export const createDailyQuota = async (date: string, qty: number, store_id: number, hampers_qty: number = 0) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .insert([{ date, qty, hampers_qty, store_id }])
        .select()
        .single();

    if (error) throw error;

    // Sync newly created quota array with Redis
    // Remaining initially equals the provisioned quantity
    try {
        const ex = ttlUntilDate(date);
        await redis.set(`quota:${store_id}:${date}`, qty, { ex });
        await redis.set(`quota:hampers:${store_id}:${date}`, hampers_qty, { ex });
    } catch (err) {
        console.error(`Failed to sync newly created quota to Redis for store ${store_id}, date: ${date}`, err);
    }

    return data;
};

export const updateDailyQuota = async (id: number, qty: number, hampers_qty?: number) => {
    const updateData: any = { qty, updated_at: new Date().toISOString() };
    if (hampers_qty !== undefined) updateData.hampers_qty = hampers_qty;

    const { data, error } = await supabase
        .from('daily_quota')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;

    // Sync the updated quota to Redis
    // Calculate the real remaining qty by querying PostgreSQL exactly how many were already sold.
    if (data && data.date) {
        await syncDailyRedisQuota(data.store_id, data.date);
    }

    return data;
};

export const deleteDailyQuota = async (id: number) => {
    // Determine the date/store to delete the keys from Redis
    const { data: qData } = await supabase
        .from('daily_quota')
        .select('date, store_id')
        .eq('id', id)
        .single();

    const { error } = await supabase
        .from('daily_quota')
        .delete()
        .eq('id', id);

    if (error) throw error;

    if (qData && qData.date) {
        try {
            await redis.del(`quota:${qData.store_id}:${qData.date}`);
            await redis.del(`quota:hampers:${qData.store_id}:${qData.date}`);
        } catch (err) {
            console.error(`Failed to delete Redis quota keys for store ${qData.store_id}, date: ${qData.date}`, err);
        }
    }

    return true;
};

export const syncDailyRedisQuota = async (store_id: number, date: string) => {
    try {
        const dqRes = await pool.query('SELECT qty, hampers_qty FROM daily_quota WHERE store_id = $1 AND date = $2::date', [store_id, date]);
        if (dqRes.rowCount === 0) return;
        const { qty, hampers_qty } = dqRes.rows[0];

        const usedRes = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN oi.box_type IN ('FULL', 'HALF') THEN oi.qty ELSE 0 END), 0) as used_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers_qty
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            WHERE to_char(o.pickup_date, 'YYYY-MM-DD') = $1
              AND o.store_id = $2
              AND o.status != 'CANCELLED'
        `, [date, store_id]);

        const soldQty = parseInt(usedRes.rows[0].used_qty, 10);
        const soldHampersQty = parseInt(usedRes.rows[0].used_hampers_qty, 10);

        const newRemaining = Math.max(0, qty - soldQty);
        const newRemainingHampers = Math.max(0, (hampers_qty || 0) - soldHampersQty);

        const ex = ttlUntilDate(date);
        await redis.set(`quota:${store_id}:${date}`, newRemaining, { ex });
        await redis.set(`quota:hampers:${store_id}:${date}`, newRemainingHampers, { ex });
    } catch (err) {
        console.error(`Failed to sync updated daily quota to Redis for store ${store_id}, date: ${date}`, err);
    }
};
