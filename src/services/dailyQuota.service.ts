import { supabase } from '../config/supabase';
import { pool } from '../config/db';
import { redis } from '../utils/redis';

export const getDailyQuotas = async () => {
    const res = await pool.query(`
        SELECT 
            id,
            to_char(date, 'YYYY-MM-DD') as date,
            qty,
            hampers_qty
        FROM daily_quota
        ORDER BY date DESC
    `);

    const keys = res.rows.flatMap(row => [`quota:${row.date}`, `quota:hampers:${row.date}`]);
    let redisVals: (string | number | null)[] = [];
    if (keys.length > 0) {
        redisVals = await redis.mget(...keys);
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
    const res = await pool.query(`
        SELECT 
            id,
            to_char(date, 'YYYY-MM-DD') as date,
            qty,
            hampers_qty
        FROM daily_quota
        WHERE date = $1::date
    `, [date]);

    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    const qty = parseFloat(row.qty);
    const hampers_qty = parseFloat(row.hampers_qty || '0');

    let remaining_qty = qty;
    let remaining_hampers_qty = hampers_qty;

    const rQty = await redis.get(`quota:${date}`);
    const rHampersQty = await redis.get(`quota:hampers:${date}`);

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
    // We only update if successful in DB. By grabbing `data.date` and performing a full calc, we can accurately set the cache.
    if (data && data.date) {
        try {
            // We need to query how much is CURRENTLY used from DB to set proper remaining cache,
            // since `qty` and `hampers_qty` just dictate the TOTAL for the day.
            const currentStats = await getDailyQuotaByDate(data.date);
            if (currentStats) {
                await redis.set(`quota:${data.date}`, currentStats.remaining_qty);
                await redis.set(`quota:hampers:${data.date}`, currentStats.remaining_hampers_qty);
            }
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
