import { supabase } from '../config/supabase';
import { pool, transaction } from '../config/db';
import { redis } from '../utils/redis';
import { syncDailyRedisQuota } from './dailyQuota.service';
import { syncHourlyRedisQuota } from './hourlyQuota.service';

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
    store_id: number;
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
    store_id?: number;
}

export const createOrder = async (payload: CreateOrderPayload) => {
    const { customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method, store_id, delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id } = payload;

    if (!store_id) {
        throw new Error('store_id tidak boleh kosong');
    }

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
    let reservedHourlyBox = false;
    let reservedHourlyHampers = false;
    let hourStr = '';

    try {
        if (requestedBoxQty > 0) {
            const remainingBoxStr = await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, -requestedBoxQty);
            const remainingBox = parseFloat(remainingBoxStr as unknown as string);
            if (remainingBox < 0) {
                // Revert atomic decrement if we've gone below zero
                await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, requestedBoxQty);
                throw new Error(`MOHON MAAF: Kuota Box untuk tanggal ${pickup_date} sudah penuh.`);
            }
            reservedBox = true;
        }

        if (requestedHampersQty > 0) {
            const remainingHampersStr = await redis.incrbyfloat(`quota:hampers:${store_id}:${pickup_date}`, -requestedHampersQty);
            const remainingHampers = parseFloat(remainingHampersStr as unknown as string);
            if (remainingHampers < 0) {
                // Revert atomic decrement
                await redis.incrbyfloat(`quota:hampers:${store_id}:${pickup_date}`, requestedHampersQty);
                // Also revert box if we reserved earlier but failed hampers
                if (reservedBox) {
                    await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, requestedBoxQty);
                }
                throw new Error(`MOHON MAAF: Kuota Hampers untuk tanggal ${pickup_date} sudah penuh.`);
            }
            reservedHampers = true;
        }

        // --- 2. HOURLY QUOTA VALIDATION (REDIS ATOMIC DECREMENT) ---
        // Runs against the plain pool (read-only queries), kept OUTSIDE the order DB
        // transaction so that Postgres connection is not held open during Redis round-trips.
        if (pickup_time) {
            hourStr = pickup_time.split(':')[0] + ':00';

            // Server-side floor check against the store's opening hour. The frontend
            // already disables hours before this, but don't rely solely on client-side filtering.
            const storeRes = await pool.query('SELECT open_time FROM stores WHERE id = $1', [store_id]);
            const openTime = storeRes.rows[0]?.open_time;
            if (openTime && hourStr < openTime) {
                throw new Error(`MOHON MAAF: Toko baru buka jam ${openTime}. Silakan pilih jam lain.`);
            }

            // Fetch base capacity and active status from DB
            const hourlyRes = await pool.query(`
                SELECT qty, hampers_qty
                FROM hourly_quota
                WHERE store_id = $1 AND time_str = $2 AND is_active = true
            `, [store_id, hourStr]);

            // If no hourly quota is configured for this slot, skip hourly-specific
            // validation entirely — the daily quota check above is the only cap that applies.
            if (hourlyRes.rowCount && hourlyRes.rowCount > 0) {
                const maxHourly = parseFloat(hourlyRes.rows[0].qty);
                const maxHourlyHampers = parseFloat(hourlyRes.rows[0].hampers_qty || '0');

                // Warm up Redis Hourly Cache if it doesn't exist.
                // Uses SET NX so that if two requests race on a cold cache, only the first
                // SET actually lands — the loser's SET becomes a no-op instead of clobbering
                // a decrement the winner may have already applied.
                const [rHourlyBox, rHourlyHampers] = await redis.mget(
                    `hourly:${store_id}:${pickup_date}:${hourStr}`,
                    `hourly:hampers:${store_id}:${pickup_date}:${hourStr}`
                );

                if (rHourlyBox === null) {
                    const usedHourlyRes = await pool.query(`
                        SELECT
                            COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END), 0) as used_box
                        FROM order_items oi
                        JOIN orders o ON oi.order_id = o.id
                        WHERE o.pickup_date = $1
                        AND o.store_id = $2
                        AND o.pickup_time LIKE $3
                        AND o.status != 'CANCELLED'
                    `, [pickup_date, store_id, `${pickup_time.split(':')[0]}:%`]);
                    const usedHourlyBox = parseFloat(usedHourlyRes.rows[0].used_box);
                    await redis.set(`hourly:${store_id}:${pickup_date}:${hourStr}`, Math.max(0, maxHourly - usedHourlyBox), { nx: true });
                }

                if (rHourlyHampers === null) {
                    const usedHourlyRes = await pool.query(`
                        SELECT
                            COALESCE(SUM(CASE WHEN oi.box_type = 'HAMPERS' THEN oi.qty ELSE 0 END), 0) as used_hampers
                        FROM order_items oi
                        JOIN orders o ON oi.order_id = o.id
                        WHERE o.pickup_date = $1
                        AND o.store_id = $2
                        AND o.pickup_time LIKE $3
                        AND o.status != 'CANCELLED'
                    `, [pickup_date, store_id, `${pickup_time.split(':')[0]}:%`]);
                    const usedHourlyHampers = parseFloat(usedHourlyRes.rows[0].used_hampers);
                    await redis.set(`hourly:hampers:${store_id}:${pickup_date}:${hourStr}`, Math.max(0, maxHourlyHampers - usedHourlyHampers), { nx: true });
                }

                // Perform Atomic Decrements for Hourly
                if (requestedBoxQty > 0) {
                    const remainingHourlyBoxStr = await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, -requestedBoxQty);
                    const remainingHourlyBox = parseFloat(remainingHourlyBoxStr as unknown as string);
                    if (remainingHourlyBox < 0) {
                        await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, requestedBoxQty);
                        throw new Error(`MOHON MAAF: Kuota Jam ${hourStr} di tanggal ${pickup_date} sudah penuh. Silakan pilih jam lain.`);
                    }
                    reservedHourlyBox = true;
                }

                if (requestedHampersQty > 0) {
                    const remainingHourlyHampersStr = await redis.incrbyfloat(`hourly:hampers:${store_id}:${pickup_date}:${hourStr}`, -requestedHampersQty);
                    const remainingHourlyHampers = parseFloat(remainingHourlyHampersStr as unknown as string);
                    if (remainingHourlyHampers < 0) {
                        await redis.incrbyfloat(`hourly:hampers:${store_id}:${pickup_date}:${hourStr}`, requestedHampersQty);
                        if (reservedHourlyBox) {
                            await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, requestedBoxQty);
                        }
                        throw new Error(`MOHON MAAF: Kuota Jam Hampers ${hourStr} di tanggal ${pickup_date} sudah penuh. Silakan pilih jam lain.`);
                    }
                    reservedHourlyHampers = true;
                }
            }
        }

        // --- 3. INSERT ORDER (short transaction: just the writes) ---
        return await transaction(async (client) => {
            const orderRes = await client.query(`
            INSERT INTO orders (
                customer_name, customer_phone, pickup_date, pickup_time, note, status, payment_method, store_id,
                delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `, [
                customer_name,
                customer_phone,
                pickup_date,
                pickup_time ?? '11:00 - 16:00',
                note ?? null,
                'UNPAID',
                payment_method ?? null,
                store_id,
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
            await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, requestedBoxQty);
        }
        if (reservedHampers) {
            await redis.incrbyfloat(`quota:hampers:${store_id}:${pickup_date}`, requestedHampersQty);
        }

        // Also rollback hourly quotas if they were reserved and then DB failed
        if (reservedHourlyBox && hourStr) {
            await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, requestedBoxQty);
        }
        if (reservedHourlyHampers && hourStr) {
            await redis.incrbyfloat(`hourly:hampers:${store_id}:${pickup_date}:${hourStr}`, requestedHampersQty);
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

    if (filters?.store_id) {
        query = query.eq('store_id', filters.store_id);
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

    const oldOrder = await getOrderById(id);

    const { data, error } = await supabase
        .from('orders')
        .update({ status: upperStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    // If order was cancelled or uncancelled, sync quotas to reclaim or use slots
    if (oldOrder && oldOrder.pickup_date) {
        if ((oldOrder.status === 'CANCELLED' && upperStatus !== 'CANCELLED') ||
            (oldOrder.status !== 'CANCELLED' && upperStatus === 'CANCELLED')) {
            await syncDailyRedisQuota(oldOrder.store_id, oldOrder.pickup_date);
            await syncHourlyRedisQuota(oldOrder.pickup_date, oldOrder.store_id);
        }
    }

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
    const oldOrder = await getOrderById(id);

    // 1. Update order header
    const updateFields: Record<string, unknown> = {};
    if (customer_name !== undefined) updateFields.customer_name = customer_name;
    if (pickup_date !== undefined) updateFields.pickup_date = pickup_date;
    if (pickup_time !== undefined) updateFields.pickup_time = pickup_time;
    if (note !== undefined) updateFields.note = note;
    if (payment_method !== undefined) updateFields.payment_method = payment_method;
    if (payload.transfer_img_url !== undefined) updateFields.transfer_img_url = payload.transfer_img_url;
    updateFields.updated_at = new Date().toISOString();

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
    }

    // Forces generic recalculation of quota usage to prevent Redis ghost slots
    if (oldOrder && oldOrder.pickup_date) {
        await syncDailyRedisQuota(oldOrder.store_id, oldOrder.pickup_date);
        await syncHourlyRedisQuota(oldOrder.pickup_date, oldOrder.store_id);
    }
    if (pickup_date && pickup_date !== oldOrder?.pickup_date) {
        // If the date changed, we must sync the new date as well
        await syncDailyRedisQuota(oldOrder.store_id, pickup_date);
        await syncHourlyRedisQuota(pickup_date, oldOrder.store_id);
    }

    if (pesanan && pesanan.length > 0) {
        return { ...order, items: pesanan };
    }
    return order;
};

export const updatePaymentMethod = async (id: number, payment_method: string | null) => {
    const { data, error } = await supabase
        .from('orders')
        .update({ payment_method, updated_at: new Date().toISOString() })
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
            SET transfer_img_url = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *
        `, [transfer_img_url, id]);

        return updateRes.rows[0];
    });
};
