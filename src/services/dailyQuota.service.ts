import { supabase } from '../config/supabase';
import { transaction } from '../config/db';

export const getDailyQuotas = async () => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT 
                dq.id,
                to_char(dq.date, 'YYYY-MM-DD') as date,
                dq.qty,
                dq.created_at,
                dq.updated_at,
                COALESCE(SUM(oi.qty), 0) as used_qty
            FROM daily_quota dq
            LEFT JOIN orders o ON o.pickup_date::text = to_char(dq.date, 'YYYY-MM-DD') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            GROUP BY dq.id, dq.date, dq.qty, dq.created_at, dq.updated_at
            ORDER BY dq.date DESC
        `);
    });

    return res.rows.map(row => ({
        ...row,
        qty: parseInt(row.qty, 10),
        used_qty: parseInt(row.used_qty, 10),
        remaining_qty: Math.max(0, parseInt(row.qty, 10) - parseInt(row.used_qty, 10))
    }));
};

export const getDailyQuotaByDate = async (date: string) => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT 
                dq.id,
                to_char(dq.date, 'YYYY-MM-DD') as date,
                dq.qty,
                COALESCE(SUM(oi.qty), 0) as used_qty
            FROM daily_quota dq
            LEFT JOIN orders o ON o.pickup_date::text = to_char(dq.date, 'YYYY-MM-DD') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE to_char(dq.date, 'YYYY-MM-DD') = $1
            GROUP BY dq.id, dq.date, dq.qty
        `, [date]);
    });

    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    return {
        ...row,
        qty: parseInt(row.qty, 10),
        used_qty: parseInt(row.used_qty, 10),
        remaining_qty: Math.max(0, parseInt(row.qty, 10) - parseInt(row.used_qty, 10))
    };
};

export const createDailyQuota = async (date: string, qty: number) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .insert([{ date, qty }])
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const updateDailyQuota = async (id: number, qty: number) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .update({ qty, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const deleteDailyQuota = async (id: number) => {
    const { error } = await supabase
        .from('daily_quota')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
};
