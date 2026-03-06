import { supabase } from '../config/supabase';
import { transaction } from '../config/db';
import { redis } from '../utils/redis';

export interface OrderItem {
    box_type: 'FULL' | 'HALF' | 'HAMPERS';
    name: string;
    qty: number;
}

export interface CreateOrderPayload {
    customer_name: string;
    customer_phone: string;
    pesanan: OrderItem[];
    pickup_date: string; // ISO date string e.g. '2026-02-26'
    pickup_time?: string;
    note?: string;
    payment_method?: string | null;
    delivery_method?: string;
    delivery_lat?: number | null;
    delivery_lng?: number | null;
    delivery_address?: string | null;
    delivery_driver_note?: string | null;
    delivery_area_id?: string | null;
}

export interface GetOrdersFilter {
    status?: string;
    day?: string; // e.g. 'RABU'
}

export const createOrder = async (payload: CreateOrderPayload) => {
    const { customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method, delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id } = payload;

    if (!pesanan || pesanan.length === 0) {
        throw new Error('pesanan tidak boleh kosong');
    }

    let requestedBoxQty = 0;
    let requestedHampersQty = 0;
    for (const item of pesanan) {
        if (item.box_type !== 'FULL' && item.box_type !== 'HALF' && item.box_type !== 'HAMPERS') {
            throw new Error(`box_type harus FULL, HALF, atau HAMPERS, got: ${item.box_type}`);
        }
        if (item.box_type === 'HALF') {
            requestedBoxQty += (item.qty * 0.5);
        } else if (item.box_type === 'FULL') {
            requestedBoxQty += item.qty;
        } else if (item.box_type === 'HAMPERS') {
            requestedHampersQty += item.qty;
        }
    }

    // --- 1. DAILY QUOTA VALIDATION (REDIS ATOMIC DECREMENT) ---
    // If no requested items, skip
    let reservedBox = false;
    let reservedHampers = false;

    if (requestedBoxQty > 0) {
        const remainingBox = await redis.decrby(`quota:${pickup_date}`, requestedBoxQty);
        if (remainingBox < 0) {
            // Revert atomic decrement if we've gone below zero
            await redis.incrby(`quota:${pickup_date}`, requestedBoxQty);
            throw new Error(`MOHON MAAF: Kuota Box untuk tanggal ${pickup_date} sudah penuh.`);
        }
        reservedBox = true;
    }

    if (requestedHampersQty > 0) {
        const remainingHampers = await redis.decrby(`quota:hampers:${pickup_date}`, requestedHampersQty);
        if (remainingHampers < 0) {
            // Revert atomic decrement
            await redis.incrby(`quota:hampers:${pickup_date}`, requestedHampersQty);
            // Also revert box if we reserved earlier but failed hampers
            if (reservedBox) {
                await redis.incrby(`quota:${pickup_date}`, requestedBoxQty);
            }
            throw new Error(`MOHON MAAF: Kuota Hampers untuk tanggal ${pickup_date} sudah penuh.`);
        }
        reservedHampers = true;
    }

    try {
        return await transaction(async (client) => {
            // --- 2. INSERT ORDER ---

            // --- 2. HOURLY QUOTA VALIDATION (disabled) ---
            // if (pickup_time) {
            //     const hourStr = pickup_time.split(':')[0] + ':00';
            //     const hourlyRes = await client.query(`
            //         SELECT qty, hampers_qty 
            //         FROM hourly_quota 
            //         WHERE time_str = $1 AND is_active = true 
            //         FOR UPDATE
            //     `, [hourStr]);
            //     if (!hourlyRes.rowCount || hourlyRes.rowCount === 0) {
            //         throw new Error(`MOHON MAAF: Jam pickup ${hourStr} belum dibuka atau sudah ditutup. Silakan pilih jam lain.`);
            //     }
            //     const maxHourly = hourlyRes.rows[0].qty;
            //     const maxHourlyHampers = hourlyRes.rows[0].hampers_qty || 0;
            //     const usedHourlyRes = await client.query(`
            //         SELECT 
            //             COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END), 0) as used_box,
            //             COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers
            //         FROM order_items oi 
            //         JOIN orders o ON oi.order_id = o.id 
            //         WHERE o.pickup_date = $1 
            //           AND o.pickup_time LIKE $2
            //           AND o.status != 'CANCELLED'
            //     `, [pickup_date, `${pickup_time.split(':')[0]}:%`]);
            //     const usedHourlyBox = parseFloat(usedHourlyRes.rows[0].used_box);
            //     const usedHourlyHampers = parseFloat(usedHourlyRes.rows[0].used_hampers);
            //     if (usedHourlyBox + requestedBoxQty > maxHourly) {
            //         const sisaHour = Math.max(0, maxHourly - usedHourlyBox);
            //         throw new Error(`MOHON MAAF: Kuota Jam ${hourStr} di tanggal ${pickup_date} sudah penuh. (Sisa Jam Ini: ${sisaHour} box). Silakan pilih jam lain.`);
            //     }
            //     if (usedHourlyHampers + requestedHampersQty > maxHourlyHampers) {
            //         const sisaHour = Math.max(0, maxHourlyHampers - usedHourlyHampers);
            //         throw new Error(`MOHON MAAF: Kuota Jam Hampers ${hourStr} di tanggal ${pickup_date} sudah penuh. (Sisa Jam Ini: ${sisaHour} hampers). Silakan pilih jam lain.`);
            //     }
            // }


            // --- 3. INSERT ORDER ---
            const orderRes = await client.query(`
            INSERT INTO orders (
                customer_name, customer_phone, pickup_date, pickup_time, note, status, payment_method,
                delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
            RETURNING *
        `, [
                customer_name,
                customer_phone,
                pickup_date,
                pickup_time ?? '11:00 - 16:00',
                note ?? null,
                'UNPAID',
                payment_method ?? null,
                delivery_method ?? 'pickup',
                delivery_lat ?? null,
                delivery_lng ?? null,
                delivery_address ?? null,
                delivery_driver_note ?? null,
                delivery_area_id ?? null,
            ]);

            const order = orderRes.rows[0];
            const orderItems = [];

            // 5. Insert order items
            for (const item of pesanan) {
                await client.query(`
                INSERT INTO order_items (order_id, box_type, name, qty) 
                VALUES ($1, $2, $3, $4)
            `, [order.id, item.box_type, item.name, item.qty]);
                orderItems.push(item);
            }
            return { ...order, items: orderItems };
        });
    } catch (e) {
        // If the database transaction failed for any reason AFTER we successfully reserved in Redis,
        // we must rollback our Redis cache decrement immediately.
        if (reservedBox) {
            await redis.incrby(`quota:${pickup_date}`, requestedBoxQty);
        }
        if (reservedHampers) {
            await redis.incrby(`quota:hampers:${pickup_date}`, requestedHampersQty);
        }
        throw e;
    }
};
export const getOrders = async (filters?: GetOrdersFilter) => {
    let query = supabase
        .from('orders')
        .select(`
            *,
            items:order_items (
                id,
                box_type,
                name,
                qty
            )
        `)
        .order('pickup_date', { ascending: true });

    if (filters?.status) {
        query = query.eq('status', filters.status.toUpperCase());
    }

    // FIX: Filter by day name using DB DOW (0=Sunday ... 6=Saturday)
    if (filters?.day) {
        const dayMap: Record<string, number> = {
            'MINGGU': 0, 'SENIN': 1, 'SELASA': 2, 'RABU': 3,
            'KAMIS': 4, 'JUMAT': 5, 'SABTU': 6,
        };
        const dowNum = dayMap[filters.day.toUpperCase()];
        if (dowNum !== undefined) {
            // Supabase doesn't directly expose DOW filter, so use raw filter via cast
            query = (query as any).filter('pickup_date', 'ov', `{${filters.day}}`)
        }
    }

    const { data, error } = await query;
    if (error) throw error;

    // Fallback in-memory day filter (handles timezone correctly)
    if (filters?.day && data) {
        const dayMap: Record<number, string> = {
            0: 'MINGGU', 1: 'SENIN', 2: 'SELASA', 3: 'RABU',
            4: 'KAMIS', 5: 'JUMAT', 6: 'SABTU',
        };
        return data.filter((order) => {
            const d = new Date(`${order.pickup_date}T00:00:00+07:00`);
            return dayMap[d.getDay()] === filters.day!.toUpperCase();
        });
    }

    return data ?? [];
};

export const getOrderById = async (id: number) => {
    const { data, error } = await supabase
        .from('orders')
        .select(`
            *,
            items:order_items (
                id,
                box_type,
                name,
                qty
            )
        `)
        .eq('id', id)
        .single();

    if (error) throw error;
    return data;
};

const VALID_STATUSES = ['UNPAID', 'PAID', 'CONFIRMED', 'DONE', 'CANCELLED'] as const;
export type OrderStatus = typeof VALID_STATUSES[number];

export const updateOrderStatus = async (id: number, status: string) => {
    const upperStatus = status.toUpperCase();

    if (!VALID_STATUSES.includes(upperStatus as OrderStatus)) {
        throw new Error(`Status tidak valid. Pilihan: ${VALID_STATUSES.join(', ')}`);
    }

    const { data, error } = await supabase
        .from('orders')
        .update({ status: upperStatus })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    return data;
};

export interface UpdateOrderPayload {
    customer_name?: string;
    pesanan?: OrderItem[];
    pickup_date?: string;
    pickup_time?: string | null;
    note?: string | null;
    payment_method?: string | null;
    transfer_img_url?: string | null;
}

export const updateOrder = async (id: number, payload: UpdateOrderPayload) => {
    const { customer_name, pesanan, pickup_date, pickup_time, note, payment_method } = payload;

    // 1. Update order header
    const updateFields: Record<string, unknown> = {};
    if (customer_name !== undefined) updateFields.customer_name = customer_name;
    if (pickup_date !== undefined) updateFields.pickup_date = pickup_date;
    if (pickup_time !== undefined) updateFields.pickup_time = pickup_time;
    if (note !== undefined) updateFields.note = note;
    if (payment_method !== undefined) updateFields.payment_method = payment_method;
    if (payload.transfer_img_url !== undefined) updateFields.transfer_img_url = payload.transfer_img_url;

    const { data: order, error: orderError } = await supabase
        .from('orders')
        .update(updateFields)
        .eq('id', id)
        .select()
        .single();

    if (orderError) throw orderError;
    if (!order) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    // 2. Replace items atomically if provided
    if (pesanan && pesanan.length > 0) {
        for (const item of pesanan) {
            if (item.box_type !== 'FULL' && item.box_type !== 'HALF' && item.box_type !== 'HAMPERS') {
                throw new Error(`box_type harus FULL, HALF, atau HAMPERS, got: ${item.box_type}`);
            }
        }

        // FIX: Wrap delete + insert in a transaction to ensure atomicity
        await transaction(async (client) => {
            await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
            for (const item of pesanan) {
                await client.query(
                    'INSERT INTO order_items (order_id, box_type, name, qty) VALUES ($1, $2, $3, $4)',
                    [id, item.box_type, item.name, item.qty]
                );
            }
        });

        return { ...order, items: pesanan };
    }

    return order;
};

export const updatePaymentMethod = async (id: number, payment_method: string | null) => {
    const { data, error } = await supabase
        .from('orders')
        .update({ payment_method })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    return data;
};

export const updateTransferImgUrl = async (id: number, transfer_img_url: string | null) => {
    return await transaction(async (client) => {
        // 1. Lock the order row specifically against concurrent modifications
        const res = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);

        if (res.rowCount === 0) {
            throw new Error(`Order dengan id ${id} tidak ditemukan`);
        }

        // 2. Perform the update safely within the lock
        const updateRes = await client.query(`
            UPDATE orders 
            SET transfer_img_url = $1
            WHERE id = $2
            RETURNING *
        `, [transfer_img_url, id]);

        return updateRes.rows[0];
    });
};
