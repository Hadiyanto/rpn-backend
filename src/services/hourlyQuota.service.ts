import { transaction } from '../config/db';

export interface HourlyQuota {
    id: number;
    time_str: string;
    qty: number;
    is_active: boolean;
}

export const getHourlyQuotas = async (): Promise<HourlyQuota[]> => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT id, time_str, qty, is_active
            FROM hourly_quota
            ORDER BY time_str ASC
        `);
    });

    return res.rows.map(row => ({
        ...row,
        qty: parseInt(row.qty, 10),
        is_active: row.is_active
    }));
};

export const getHourlyAvailability = async (date: string): Promise<(HourlyQuota & { used_qty: number, remaining_qty: number })[]> => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT 
                hq.id, 
                hq.time_str, 
                hq.qty, 
                hq.is_active,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 ELSE oi.qty END), 0) as used_qty
            FROM hourly_quota hq
            LEFT JOIN orders o ON o.pickup_date = $1 AND o.pickup_time LIKE (substring(hq.time_str, 1, 2) || '%') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            GROUP BY hq.id, hq.time_str, hq.qty, hq.is_active
            ORDER BY hq.time_str ASC
        `, [date]);
    });

    return res.rows.map(row => {
        const qty = parseFloat(row.qty);
        const used_qty = parseFloat(row.used_qty);
        return {
            ...row,
            qty,
            used_qty,
            is_active: row.is_active,
            remaining_qty: Math.max(0, qty - used_qty)
        };
    });
};

export const upsertHourlyQuota = async (time_str: string, qty: number, is_active: boolean = true) => {
    const res = await transaction(async (client) => {
        return client.query(`
            INSERT INTO hourly_quota (time_str, qty, is_active)
            VALUES ($1, $2, $3)
            ON CONFLICT (time_str) DO UPDATE 
            SET qty = EXCLUDED.qty, is_active = EXCLUDED.is_active, updated_at = current_timestamp
            RETURNING *
        `, [time_str, qty, is_active]);
    });
    return res.rows[0];
};

export const deleteHourlyQuota = async (id: number) => {
    await transaction(async (client) => {
        return client.query('DELETE FROM hourly_quota WHERE id = $1', [id]);
    });
    return true;
};
