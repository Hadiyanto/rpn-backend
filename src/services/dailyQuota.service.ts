import { supabase } from '../config/supabase';
import { pool } from '../config/db';
import { redis } from '../utils/redis';

export const getDailyQuotas = async () => {
    console.log('[DEBUG] getDailyQuotas: Fetching from DB...');
    const res = await pool.query(`
        SELECT 
            id,
            to_char(date, 'YYYY-MM-DD') as date,
            qty,
            hampers_qty
        FROM daily_quota
        ORDER BY date DESC
    `);
    console.log(`[DEBUG] getDailyQuotas: DB fetched ${res.rowCount} rows.`);

    const keys = res.rows.flatMap(row => [`quota:${row.date}`, `quota:hampers:${row.date}`]);
    let redisVals: (string | number | null)[] = [];
    if (keys.length > 0) {
        console.log(`[DEBUG] getDailyQuotas: Fetching ${keys.length} keys from Redis...`);
        redisVals = await redis.mget(...keys);
        console.log('[DEBUG] getDailyQuotas: Redis fetch complete.');
    }

    return res.rows.map((row, i) => {
        const qty = parseFloat(row.qty);
        const hampers_qty = parseFloat(row.hampers_qty || '0');

        let remaining_qty = qty;
        let remaining_hampers_qty = hampers_qty;

        // Use Redis value if exists
        const rQty = redisVals[i * 2];
        const rHampersQty = redisVals[i * 2 + 1];

        if (rQty !== null && rQty !== undefined) {
            remaining_qty = Math.max(0, Number(rQty));
        }
        if (rHampersQty !== null && rHampersQty !== undefined) {
            remaining_hampers_qty = Math.max(0, Number(rHampersQty));
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

export const getDailyQuotaByDate = async (date: string) => {
    console.log(`[DEBUG] getDailyQuotaByDate: Fetching DB for date ${date}...`);
    const res = await pool.query(`
        SELECT 
            id,
            to_char(date, 'YYYY-MM-DD') as date,
            qty,
            hampers_qty
        FROM daily_quota
        WHERE date = $1::date
    `, [date]);
    console.log(`[DEBUG] getDailyQuotaByDate: DB result rowCount = ${res.rowCount}`);

    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    const qty = parseFloat(row.qty);
    const hampers_qty = parseFloat(row.hampers_qty || '0');

    let remaining_qty = qty;
    let remaining_hampers_qty = hampers_qty;

    console.log(`[DEBUG] getDailyQuotaByDate: Fetching Redis keys for ${date}...`);
    const rQty = await redis.get(`quota:${date}`);
    const rHampersQty = await redis.get(`quota:hampers:${date}`);
    console.log(`[DEBUG] getDailyQuotaByDate: Redis fetch complete. rQty=${rQty}, rHampersQty=${rHampersQty}`);

    if (rQty !== null && rQty !== undefined) {
        remaining_qty = Math.max(0, Number(rQty));
    }
    if (rHampersQty !== null && rHampersQty !== undefined) {
        remaining_hampers_qty = Math.max(0, Number(rHampersQty));
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

export const createDailyQuota = async (date: string, qty: number, hampers_qty: number = 0) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .insert([{ date, qty, hampers_qty }])
        .select()
        .single();

    if (error) throw error;

    // Sync newly created quota array with Redis
    // Remaining initially equals the provisioned quantity
    try {
        await redis.set(`quota:${date}`, qty);
        await redis.set(`quota:hampers:${date}`, hampers_qty);
    } catch (err) {
        console.error(`Failed to sync newly created quota to Redis for date: ${date}`, err);
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
        try {
            // Re-calculate how many were sold to get the correct remaining balance
            const usedRes = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN oi.box_type IN ('FULL', 'HALF') THEN oi.qty ELSE 0 END), 0) as used_qty,
                    COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers_qty
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                WHERE to_char(o.pickup_date, 'YYYY-MM-DD') = $1
                  AND o.status != 'CANCELLED'
            `, [data.date]);

            const soldQty = parseInt(usedRes.rows[0].used_qty, 10);
            const soldHampersQty = parseInt(usedRes.rows[0].used_hampers_qty, 10);

            const newRemaining = Math.max(0, data.qty - soldQty);
            const newRemainingHampers = Math.max(0, (data.hampers_qty || 0) - soldHampersQty);

            await redis.set(`quota:${data.date}`, newRemaining);
            await redis.set(`quota:hampers:${data.date}`, newRemainingHampers);
        } catch (err) {
            console.error(`Failed to sync updated quota to Redis for date: ${data.date}`, err);
        }
    }

    return data;
};

export const deleteDailyQuota = async (id: number) => {
    // Determine the date to delete the keys from Redis
    const { data: qData } = await supabase
        .from('daily_quota')
        .select('date')
        .eq('id', id)
        .single();

    const { error } = await supabase
        .from('daily_quota')
        .delete()
        .eq('id', id);

    if (error) throw error;

    if (qData && qData.date) {
        try {
            await redis.del(`quota:${qData.date}`);
            await redis.del(`quota:hampers:${qData.date}`);
        } catch (err) {
            console.error(`Failed to delete Redis quota keys for date: ${qData.date}`, err);
        }
    }

    return true;
};
