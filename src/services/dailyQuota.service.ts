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
                dq.hampers_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END), 0) as used_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers_qty
            FROM daily_quota dq
            LEFT JOIN orders o ON o.pickup_date::text = to_char(dq.date, 'YYYY-MM-DD') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            GROUP BY dq.id, dq.date, dq.qty, dq.hampers_qty, dq.created_at, dq.updated_at
            ORDER BY dq.date DESC
        `);
    });

    return res.rows.map(row => {
        const qty = parseFloat(row.qty);
        const used_qty = parseFloat(row.used_qty);
        const hampers_qty = parseFloat(row.hampers_qty || '0');
        const used_hampers_qty = parseFloat(row.used_hampers_qty || '0');
        return {
            ...row,
            qty,
            used_qty,
            remaining_qty: Math.max(0, qty - used_qty),
            hampers_qty,
            used_hampers_qty,
            remaining_hampers_qty: Math.max(0, hampers_qty - used_hampers_qty)
        };
    });
};

export const getDailyQuotaByDate = async (date: string) => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT 
                dq.id,
                to_char(dq.date, 'YYYY-MM-DD') as date,
                dq.qty,
                dq.hampers_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END), 0) as used_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers_qty
            FROM daily_quota dq
            LEFT JOIN orders o ON o.pickup_date::text = to_char(dq.date, 'YYYY-MM-DD') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE to_char(dq.date, 'YYYY-MM-DD') = $1
            GROUP BY dq.id, dq.date, dq.qty, dq.hampers_qty
        `, [date]);
    });

    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    const qty = parseFloat(row.qty);
    const used_qty = parseFloat(row.used_qty);
    const hampers_qty = parseFloat(row.hampers_qty || '0');
    const used_hampers_qty = parseFloat(row.used_hampers_qty || '0');
    return {
        ...row,
        qty,
        used_qty,
        remaining_qty: Math.max(0, qty - used_qty),
        hampers_qty,
        used_hampers_qty,
        remaining_hampers_qty: Math.max(0, hampers_qty - used_hampers_qty)
    };
};

export const createDailyQuota = async (date: string, qty: number, hampers_qty: number = 0) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .insert([{ date, qty, hampers_qty }])
        .select()
        .single();

    if (error) throw error;
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
