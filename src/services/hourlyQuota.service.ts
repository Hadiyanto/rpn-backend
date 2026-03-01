import { transaction } from '../config/db';

export interface HourlyQuota {
    id: number;
    time_str: string;
    qty: number;
    hampers_qty: number;
    is_active: boolean;
}

export const getHourlyQuotas = async (): Promise<HourlyQuota[]> => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT id, time_str, qty, hampers_qty, is_active
            FROM hourly_quota
            ORDER BY time_str ASC
        `);
    });

    return res.rows.map(row => ({
        ...row,
        qty: parseInt(row.qty, 10),
        hampers_qty: parseInt(row.hampers_qty || '0', 10),
        is_active: row.is_active
    }));
};

export const getHourlyAvailability = async (date: string): Promise<(HourlyQuota & { used_qty: number, remaining_qty: number, used_hampers_qty: number, remaining_hampers_qty: number })[]> => {
    const res = await transaction(async (client) => {
        return client.query(`
            SELECT 
                hq.id, 
                hq.time_str, 
                hq.qty, 
                hq.hampers_qty,
                hq.is_active,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END), 0) as used_qty,
                COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers_qty
            FROM hourly_quota hq
            LEFT JOIN orders o ON o.pickup_date = $1 AND o.pickup_time LIKE (substring(hq.time_str, 1, 2) || '%') AND o.status != 'CANCELLED'
            LEFT JOIN order_items oi ON oi.order_id = o.id
            GROUP BY hq.id, hq.time_str, hq.qty, hq.hampers_qty, hq.is_active
            ORDER BY hq.time_str ASC
        `, [date]);
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
            is_active: row.is_active,
            remaining_qty: Math.max(0, qty - used_qty),
            hampers_qty,
            used_hampers_qty,
            remaining_hampers_qty: Math.max(0, hampers_qty - used_hampers_qty)
        };
    });
};

export const upsertHourlyQuota = async (time_str: string, qty: number, hampers_qty: number = 0, is_active: boolean = true) => {
    const res = await transaction(async (client) => {
        return client.query(`
            INSERT INTO hourly_quota (time_str, qty, hampers_qty, is_active)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (time_str) DO UPDATE 
            SET qty = EXCLUDED.qty, hampers_qty = EXCLUDED.hampers_qty, is_active = EXCLUDED.is_active, updated_at = current_timestamp
            RETURNING *
        `, [time_str, qty, hampers_qty, is_active]);
    });
    return res.rows[0];
};

export const deleteHourlyQuota = async (id: number) => {
    await transaction(async (client) => {
        return client.query('DELETE FROM hourly_quota WHERE id = $1', [id]);
    });
    return true;
};
