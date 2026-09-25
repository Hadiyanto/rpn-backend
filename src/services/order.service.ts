import { pool, transaction } from '../config/db';
import { redis, ttlUntilDate } from '../utils/redis';
import { BOX_UNITS_SQL, boxUnits, remainingQuota } from '../utils/boxUnits';
import { dayOfWeek } from '../utils/date';
import { ConflictError, NotFoundError } from '../utils/errors';
import { ensureDailyQuotaKey, syncDailyRedisQuota } from './dailyQuota.service';
import { syncHourlyRedisQuota } from './hourlyQuota.service';
import { checkVariantSelection, loadVariantCatalog } from './variantRecipe.service';
import { applyOrderStockSafe, reverseOrderStockSafe } from './stockDeduction.service';
import type { PoolClient } from 'pg';
import {
    ValidationError,
    type ValidOrderItem,
    validateCustomerName,
    validateNote,
    validateOrderItems,
    validatePhone,
    validatePickupDate,
    validatePickupTime,
    validateStoreId,
} from '../utils/validation';

export type BoxType = 'FULL' | 'HALF';

export interface OrderItem {
    box_type: BoxType;
    name: string;
    qty: number;
    variant_ids?: number[];
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

/** Checks every item's variant_ids against the live catalog (active, different flavors, max_flavors). */
const assertVariantSelections = async (items: ValidOrderItem[]) => {
    if (!items.some(item => item.variant_ids)) return;
    const catalog = await loadVariantCatalog();
    items.forEach((item, idx) => {
        if (item.variant_ids) checkVariantSelection(item.variant_ids, item.box_type, catalog, `Item ${idx + 1}`);
    });
};

/** Every item's box must be an active menu row sold at this store (e.g. a deleted Box Kecil can't be ordered). */
const assertBoxesAvailable = async (storeId: number, items: ValidOrderItem[]) => {
    const { rows } = await pool.query(
        'SELECT name FROM menu WHERE is_active IS NOT FALSE AND $1 = ANY(store_ids)',
        [storeId]
    );
    const sold = new Set(rows.map(r => r.name));
    for (const item of items) {
        if (!sold.has(item.box_type)) {
            throw new ValidationError(`${item.box_type === 'HALF' ? 'Box Kecil' : 'Box Besar'} tidak tersedia di store ini`);
        }
    }
};

/** Inserts order_items (+ their order_item_variants) for an order inside an open transaction. */
const insertOrderItems = async (client: PoolClient, orderId: number, items: ValidOrderItem[]) => {
    for (const item of items) {
        const { rows: [row] } = await client.query(
            'INSERT INTO order_items (order_id, box_type, name, qty) VALUES ($1, $2, $3, $4) RETURNING id',
            [orderId, item.box_type, item.name, item.qty]
        );
        for (const variantId of item.variant_ids ?? []) {
            await client.query(
                'INSERT INTO order_item_variants (order_item_id, variant_id) VALUES ($1, $2)',
                [row.id, variantId]
            );
        }
    }
};

/** Adds `variant_ids` to every item of the given orders (empty array for legacy items). */
const attachVariantIds = async <T extends { items?: { id: number }[] | null }>(orders: T[]): Promise<T[]> => {
    const itemIds = orders.flatMap(o => (o.items ?? []).map(i => i.id));
    if (itemIds.length === 0) return orders;

    const { rows } = await pool.query(
        'SELECT order_item_id, variant_id FROM order_item_variants WHERE order_item_id = ANY($1::int[]) ORDER BY id',
        [itemIds]
    );
    const byItem = new Map<number, number[]>();
    for (const r of rows) byItem.set(r.order_item_id, [...(byItem.get(r.order_item_id) ?? []), r.variant_id]);

    for (const order of orders) {
        for (const item of order.items ?? []) {
            (item as { variant_ids?: number[] }).variant_ids = byItem.get(item.id) ?? [];
        }
    }
    return orders;
};

export const createOrder = async (payload: CreateOrderPayload) => {
    const { payment_method, delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id } = payload;

    // Validate everything before touching Redis: a negative qty would otherwise
    // *increase* the remaining quota via incrbyfloat.
    const store_id = validateStoreId(payload.store_id);
    const customer_name = validateCustomerName(payload.customer_name);
    const customer_phone = validatePhone(payload.customer_phone);
    const pesanan = validateOrderItems(payload.pesanan);
    const pickup_date = validatePickupDate(payload.pickup_date);
    const pickup_time = validatePickupTime(payload.pickup_time);
    const note = validateNote(payload.note);
    await assertBoxesAvailable(store_id, pesanan);
    await assertVariantSelections(pesanan);

    const requestedBoxQty = boxUnits(pesanan);

    // --- 1. DAILY QUOTA VALIDATION (REDIS ATOMIC DECREMENT) ---
    // If no requested items, skip
    let reservedBox = false;
    let reservedHourlyBox = false;
    let hourStr = '';

    try {
        if (requestedBoxQty > 0) {
            await ensureDailyQuotaKey(store_id, pickup_date);
            const remainingBoxStr = await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, -requestedBoxQty);
            const remainingBox = parseFloat(remainingBoxStr as unknown as string);
            if (remainingBox < 0) {
                // Revert atomic decrement if we've gone below zero
                await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, requestedBoxQty);
                throw new ConflictError(`MOHON MAAF: Kuota Box untuk tanggal ${pickup_date} sudah penuh.`);
            }
            reservedBox = true;
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
                throw new ConflictError(`MOHON MAAF: Toko baru buka jam ${openTime}. Silakan pilih jam lain.`);
            }

            // Fetch base capacity and active status from DB
            const hourlyRes = await pool.query(`
                SELECT qty
                FROM hourly_quota
                WHERE store_id = $1 AND time_str = $2 AND is_active = true
            `, [store_id, hourStr]);

            // If no hourly quota is configured for this slot, skip hourly-specific
            // validation entirely — the daily quota check above is the only cap that applies.
            if (hourlyRes.rowCount && hourlyRes.rowCount > 0) {
                const maxHourly = parseFloat(hourlyRes.rows[0].qty);

                // Warm up Redis Hourly Cache if it doesn't exist.
                // Uses SET NX so that if two requests race on a cold cache, only the first
                // SET actually lands — the loser's SET becomes a no-op instead of clobbering
                // a decrement the winner may have already applied.
                const rHourlyBox = await redis.get(`hourly:${store_id}:${pickup_date}:${hourStr}`);

                if (rHourlyBox === null) {
                    const usedHourlyRes = await pool.query(`
                        SELECT
                            COALESCE(SUM(${BOX_UNITS_SQL}), 0) as used_box
                        FROM order_items oi
                        JOIN orders o ON oi.order_id = o.id
                        WHERE o.pickup_date = $1
                        AND o.store_id = $2
                        AND o.pickup_time LIKE $3
                        AND o.status != 'CANCELLED'
                    `, [pickup_date, store_id, `${pickup_time.split(':')[0]}:%`]);
                    const usedHourlyBox = parseFloat(usedHourlyRes.rows[0].used_box);
                    await redis.set(`hourly:${store_id}:${pickup_date}:${hourStr}`, remainingQuota(maxHourly, usedHourlyBox), { nx: true, ex: ttlUntilDate(pickup_date) });
                }

                // Perform Atomic Decrements for Hourly
                if (requestedBoxQty > 0) {
                    const remainingHourlyBoxStr = await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, -requestedBoxQty);
                    const remainingHourlyBox = parseFloat(remainingHourlyBoxStr as unknown as string);
                    if (remainingHourlyBox < 0) {
                        await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, requestedBoxQty);
                        throw new ConflictError(`MOHON MAAF: Kuota Jam ${hourStr} di tanggal ${pickup_date} sudah penuh. Silakan pilih jam lain.`);
                    }
                    reservedHourlyBox = true;
                }
            }
        }

        // --- 3. INSERT ORDER (short transaction: just the writes) ---
        const created = await transaction(async (client) => {
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
            await insertOrderItems(client, order.id, pesanan);
            return { ...order, items: pesanan };
        });

        // --- 4. STOCK: deduct raw materials right away (UNPAID included). Runs after commit and
        // never throws, so a stock/recipe problem can never fail or roll back the order.
        await applyOrderStockSafe(created.id);

        return created;
    } catch (e) {
        // If the database transaction failed for any reason AFTER we successfully reserved in Redis,
        // we must rollback our Redis cache decrement immediately.
        if (reservedBox) {
            await redis.incrbyfloat(`quota:${store_id}:${pickup_date}`, requestedBoxQty);
        }

        // Also rollback hourly quotas if they were reserved and then DB failed
        if (reservedHourlyBox && hourStr) {
            await redis.incrbyfloat(`hourly:${store_id}:${pickup_date}:${hourStr}`, requestedBoxQty);
        }

        throw e;
    }
};
// Order row + items: [{ id, box_type, name, qty }] — the shape the supabase-js embed returned.
const ORDER_WITH_ITEMS_COLUMNS = `
    o.*,
    COALESCE(
        json_agg(json_build_object('id', oi.id, 'box_type', oi.box_type, 'name', oi.name, 'qty', oi.qty) ORDER BY oi.id)
            FILTER (WHERE oi.id IS NOT NULL),
        '[]'
    ) AS items`;

export const getOrders = async (filters?: GetOrdersFilter) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters?.status) {
        params.push(filters.status.toUpperCase());
        where.push(`o.status = $${params.length}`);
    }
    if (filters?.store_id) {
        params.push(filters.store_id);
        where.push(`o.store_id = $${params.length}`);
    }

    const { rows: data } = await pool.query(`
        SELECT ${ORDER_WITH_ITEMS_COLUMNS}
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY o.id
        ORDER BY o.pickup_date ASC, o.id ASC
    `, params);

    // Day-name filter, computed from the calendar date itself so it doesn't depend on the
    // server timezone (the old getDay() on a +07:00 timestamp was off by one on a UTC server).
    if (filters?.day) {
        const dayNames = ['MINGGU', 'SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU'];
        return attachVariantIds(data.filter(order => dayNames[dayOfWeek(order.pickup_date)] === filters.day!.toUpperCase()));
    }

    return attachVariantIds(data);
};

export const getOrderById = async (id: number) => {
    // Same shape as the previous supabase-js query: the order row plus
    // items: [{ id, box_type, name, qty }], now also with variant_ids per item.
    const { rows } = await pool.query(`
        SELECT ${ORDER_WITH_ITEMS_COLUMNS}
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.id = $1
        GROUP BY o.id
    `, [id]);

    // supabase .single() threw when no row matched; callers rely on that.
    if (rows.length === 0) throw new NotFoundError(`Order dengan id ${id} tidak ditemukan`);
    const [withVariants] = await attachVariantIds(rows);
    return withVariants;
};

const VALID_STATUSES = ['UNPAID', 'PAID', 'CONFIRMED', 'DONE', 'CANCELLED'] as const;
export type OrderStatus = typeof VALID_STATUSES[number];

export const updateOrderStatus = async (id: number, status: string) => (await changeOrderStatus(id, status)).order;

/** Status update that also reports the previous status, so callers can run change-only side effects. */
export const changeOrderStatus = async (id: number, status: string) => {
    const upperStatus = status.toUpperCase();

    if (!VALID_STATUSES.includes(upperStatus as OrderStatus)) {
        throw new ValidationError(`Status tidak valid. Pilihan: ${VALID_STATUSES.join(', ')}`);
    }

    const oldOrder = await getOrderById(id);

    const { rows } = await pool.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [upperStatus, id]
    );
    const data = rows[0];
    if (!data) throw new NotFoundError(`Order dengan id ${id} tidak ditemukan`);

    const wasCancelled = oldOrder.status === 'CANCELLED';
    const isCancelled = upperStatus === 'CANCELLED';

    // If order was cancelled or uncancelled, sync quotas to reclaim or use slots
    if (oldOrder.pickup_date && wasCancelled !== isCancelled) {
        await syncDailyRedisQuota(oldOrder.store_id, oldOrder.pickup_date);
        await syncHourlyRedisQuota(oldOrder.pickup_date, oldOrder.store_id);
    }

    // K1: cancelling gives the raw materials back; un-cancelling takes them again.
    if (!wasCancelled && isCancelled) await reverseOrderStockSafe(id);
    if (wasCancelled && !isCancelled) await applyOrderStockSafe(id);

    return { order: data, previousStatus: oldOrder.status as string };
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
    const { payment_method } = payload;
    const oldOrder = await getOrderById(id);

    // Admin edits may keep an order's existing (possibly past) date, but a changed
    // date must follow the same rules as a new order.
    const customer_name = payload.customer_name === undefined ? undefined : validateCustomerName(payload.customer_name);
    const pesanan = payload.pesanan && payload.pesanan.length > 0 ? validateOrderItems(payload.pesanan) : undefined;
    const pickup_date = payload.pickup_date === undefined
        ? undefined
        : validatePickupDate(payload.pickup_date, { allowPast: payload.pickup_date === oldOrder?.pickup_date });
    const pickup_time = payload.pickup_time === undefined || payload.pickup_time === null
        ? payload.pickup_time
        : (validatePickupTime(payload.pickup_time) ?? null);
    const note = validateNote(payload.note);
    if (pesanan) {
        await assertBoxesAvailable(oldOrder.store_id, pesanan);
        await assertVariantSelections(pesanan);
    }

    // 1+2. Header update and item replacement in ONE transaction, so a failed item insert
    // can never leave the header changed with the old items (or no items at all).
    const updateFields: Record<string, unknown> = {};
    if (customer_name !== undefined) updateFields.customer_name = customer_name;
    if (pickup_date !== undefined) updateFields.pickup_date = pickup_date;
    if (pickup_time !== undefined) updateFields.pickup_time = pickup_time;
    if (note !== undefined) updateFields.note = note;
    if (payment_method !== undefined) updateFields.payment_method = payment_method;
    if (payload.transfer_img_url !== undefined) updateFields.transfer_img_url = payload.transfer_img_url;

    const order = await transaction(async (client) => {
        const locked = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);
        if (locked.rowCount === 0) {
            throw new NotFoundError(`Order dengan id ${id} tidak ditemukan`);
        }

        // Column names come from the fixed list above, never from user input.
        const columns = Object.keys(updateFields);
        const setClause = [...columns.map((col, i) => `${col} = $${i + 2}`), 'updated_at = CURRENT_TIMESTAMP'].join(', ');
        const orderRes = await client.query(
            `UPDATE orders SET ${setClause} WHERE id = $1 RETURNING *`,
            [id, ...columns.map(col => updateFields[col])]
        );

        if (pesanan) {
            // order_item_variants rows go with their items (ON DELETE CASCADE).
            await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
            await insertOrderItems(client, id, pesanan);
        }

        return orderRes.rows[0];
    });

    // K1: edited items → give back the old deduction and deduct for the new items.
    // (applyOrderStock itself skips cancelled orders.)
    if (pesanan) {
        await reverseOrderStockSafe(id);
        await applyOrderStockSafe(id);
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

    if (pesanan) {
        return { ...order, items: pesanan };
    }
    return order;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer-facing view of an order, looked up by its unguessable public_token.
 * Only what the "bukti transfer" page needs — no phone number, address or coordinates.
 */
export const getPublicOrder = async (token: string) => {
    const order = await getOrderById(await getOrderIdByPublicToken(token));
    return {
        id: order.id,
        customer_name: order.customer_name,
        pickup_date: order.pickup_date,
        pickup_time: order.pickup_time,
        status: order.status,
        payment_method: order.payment_method,
        store_id: order.store_id,
        has_transfer_img: !!order.transfer_img_url,
        items: order.items.map((i: { box_type: string; name: string; qty: number }) => ({ box_type: i.box_type, name: i.name, qty: i.qty })),
    };
};

/** Resolves a public token to the internal order id (404 when unknown). */
export const getOrderIdByPublicToken = async (token: string): Promise<number> => {
    if (!UUID_RE.test(token)) throw new NotFoundError('Order tidak ditemukan');
    const { rows } = await pool.query('SELECT id FROM orders WHERE public_token = $1', [token]);
    if (rows.length === 0) throw new NotFoundError('Order tidak ditemukan');
    return rows[0].id;
};

// Transfer proofs must be images we uploaded ourselves (see POST /upload-image).
export const assertTransferImgUrl = (url: unknown): string => {
    if (typeof url !== 'string' || !/^https:\/\/res\.cloudinary\.com\//.test(url)) {
        throw new ValidationError('transfer_img_url harus berupa URL gambar hasil upload');
    }
    return url;
};

export const updatePaymentMethod = async (id: number, payment_method: string | null) => {
    const { rows: [data] } = await pool.query(
        'UPDATE orders SET payment_method = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
        [id, payment_method]
    );
    if (!data) throw new NotFoundError(`Order dengan id ${id} tidak ditemukan`);
    return data;
};

export const updateTransferImgUrl = async (id: number, transfer_img_url: string | null) => {
    return await transaction(async (client) => {
        // 1. Lock the order row specifically against concurrent modifications
        const res = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);

        if (res.rowCount === 0) {
            throw new NotFoundError(`Order dengan id ${id} tidak ditemukan`);
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
