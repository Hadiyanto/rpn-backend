import { pool, transaction } from '../config/db';
import { redis } from '../utils/redis';

export interface HourlyQuota {
    id: number;
    time_str: string;
    qty: number;
    hampers_qty: number;
    is_active: boolean;
}

export const getHourlyQuotas = async (): Promise<HourlyQuota[]> => {
    const res = await pool.query(`
        SELECT id, time_str, qty, hampers_qty, is_active
        FROM hourly_quota
        ORDER BY time_str ASC
    `);

    return res.rows.map(row => ({
        ...row,
        qty: parseInt(row.qty, 10),
        hampers_qty: parseInt(row.hampers_qty || '0', 10),
        is_active: row.is_active
    }));
};

export const getHourlyAvailability = async (date: string): Promise<(HourlyQuota & { used_qty: number, remaining_qty: number, used_hampers_qty: number, remaining_hampers_qty: number })[]> => {
    const res = await pool.query(`
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

    // Fetch all Redis keys at once for this date's time slots
    const keys = res.rows.flatMap(row => [
        `hourly:${date}:${row.time_str}`,
        `hourly:hampers:${date}:${row.time_str}`
    ]);

    let redisVals: (string | number | null)[] = [];
    if (keys.length > 0) {
        redisVals = await redis.mget(...keys);
    }

    return res.rows.map((row, i) => {
        const qty = parseFloat(row.qty);
        const hampers_qty = parseFloat(row.hampers_qty || '0');

        let remaining_qty = Math.max(0, qty - parseFloat(row.used_qty));
        let remaining_hampers_qty = Math.max(0, hampers_qty - parseFloat(row.used_hampers_qty || '0'));

        const rQty = redisVals[i * 2];
        const rHampersQty = redisVals[i * 2 + 1];

        if (rQty !== null && rQty !== undefined) {
            remaining_qty = Math.max(0, Number(rQty));
            if (qty < remaining_qty) {
                remaining_qty = Math.max(0, qty);
                redis.set(`hourly:${date}:${row.time_str}`, remaining_qty).catch(console.error);
            }
        } else {
            redis.set(`hourly:${date}:${row.time_str}`, remaining_qty).catch(console.error);
        }

        if (rHampersQty !== null && rHampersQty !== undefined) {
            remaining_hampers_qty = Math.max(0, Number(rHampersQty));
            if (hampers_qty < remaining_hampers_qty) {
                remaining_hampers_qty = Math.max(0, hampers_qty);
                redis.set(`hourly:hampers:${date}:${row.time_str}`, remaining_hampers_qty).catch(console.error);
            }
        } else {
            redis.set(`hourly:hampers:${date}:${row.time_str}`, remaining_hampers_qty).catch(console.error);
        }

        const used_qty = Math.max(0, qty - remaining_qty);
        const used_hampers_qty = Math.max(0, hampers_qty - remaining_hampers_qty);

        return {
            ...row,
            qty,
            used_qty,
            is_active: row.is_active,
            remaining_qty,
            hampers_qty,
            used_hampers_qty,
            remaining_hampers_qty
        };
    });
};

// Write operations still use transaction for data integrity
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

    // Invalidate the base cache keys
    try {
        await redis.set(`hourly:base:${time_str}`, qty);
        await redis.set(`hourly:hampers:base:${time_str}`, hampers_qty);
        // Note: We cannot easily invalidate all specific hourly date keys here. 
        // Their DB fallbacks will eventually correct them if they expire, but if they exist, they will retain the old Remaining value until an order is placed.
    } catch (err) {
        console.error('Failed to update base hourly quota in Redis', err);
    }

    return res.rows[0];
};

export const deleteHourlyQuota = async (id: number) => {
    await transaction(async (client) => {
        return client.query('DELETE FROM hourly_quota WHERE id = $1', [id]);
    });
    return true;
};
