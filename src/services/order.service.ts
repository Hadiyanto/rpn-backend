import { pool, transaction } from '../config/db';
import { redis, ttlUntilDate } from '../utils/redis';
import { BOX_UNITS_SQL, boxUnits, remainingQuota } from '../utils/boxUnits';
import { dayOfWeek, nowTimeWIB, todayWIB } from '../utils/date';
import { redisKeys } from '../utils/redisKeys';
import { ConflictError, NotFoundError, UpstreamError } from '../utils/errors';
import { ensureDailyQuotaKey } from './dailyQuota.service';
import { checkVariantSelection, loadVariantCatalog } from './variantRecipe.service';
import { applyOrderStockSafe, reverseOrderStockSafe } from './stockDeduction.service';
import { priceOrderItems } from './variantPrice.service';
import { flavorName } from '../utils/flavorName';
import { cancelActiveDeliveries, getStoreDeliveryOptions, isStoreDeliveryAllowed, type DeliveryQuote } from './biteship.service';
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
    /** Store delivery courier the customer picked from the options (Biteship courier_code / service_code). */
    delivery_courier_company?: string | null;
    delivery_courier_type?: string | null;
}

export interface GetOrdersFilter {
    status?: string;
    day?: string; // e.g. 'RABU'
    store_id?: number;
    /** Pickup date range (YYYY-MM-DD, inclusive). */
    from?: string;
    to?: string;
}

/** Checks every item's variant_ids against the live catalog (active, different flavors, max_flavors). */
const assertVariantSelections = async (items: ValidOrderItem[]) => {
    if (!items.some(item => item.variant_ids)) return;
    const catalog = await loadVariantCatalog();
    items.forEach((item, idx) => {
        if (item.variant_ids) checkVariantSelection(item.variant_ids, item.box_type, catalog, `Item ${idx + 1}`);
    });
};

/**
 * New items must name their flavors by id: price, stock deduction and the stored name all follow
 * variant_ids. Without them an item fell back to the box's menu price and a free-text name, so a
 * crafted request could buy Choco Special at the plain box price (review 2026-10-19, H1).
 */
const assertVariantIdsGiven = (items: ValidOrderItem[]) => {
    items.forEach((item, idx) => {
        if (!item.variant_ids || item.variant_ids.length === 0) throw new ValidationError(`Item ${idx + 1}: pilih minimal 1 rasa`);
    });
};

/**
 * The stored item name comes from the chosen variants, never from the client, so the kitchen, WhatsApp
 * and receipts always show the flavors that were priced (review 2026-10-19, H2). Items without
 * variant_ids (legacy rows kept by an admin edit) keep their name.
 */
const nameItemsByVariants = async <T extends ValidOrderItem>(items: T[]): Promise<T[]> => {
    const ids = [...new Set(items.flatMap(item => item.variant_ids ?? []))];
    if (ids.length === 0) return items;
    const { rows } = await pool.query('SELECT id, variant_name FROM variant WHERE id = ANY($1::int[])', [ids]);
    const names = new Map(rows.map(r => [Number(r.id), String(r.variant_name)]));
    return items.map(item => item.variant_ids && item.variant_ids.length > 0
        ? { ...item, name: flavorName(item.variant_ids.map(id => names.get(id) ?? `#${id}`)) }
        : item);
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

export type PricedOrderItem = ValidOrderItem & { unit_price: number; price_variant_id: number | null };

const DELIVERY_UNAVAILABLE = 'Store Delivery tidak tersedia untuk pesanan ini';

const assertStoreOpenForOrders = async (storeId: number) => {
    const { rows } = await pool.query('SELECT is_open_for_orders FROM stores WHERE id = $1', [storeId]);
    if (!rows[0]) throw new NotFoundError(`Store dengan id ${storeId} tidak ditemukan`);
    if (rows[0].is_open_for_orders === false) throw new ConflictError('Toko sedang tutup dan belum menerima order baru.');
};

/** Delivery options for these (priced) items, as Biteship quotes them right now. */
const deliveryOptionsFor = async (storeId: number, payload: Pick<CreateOrderPayload, 'delivery_lat' | 'delivery_lng' | 'customer_phone'>, items: PricedOrderItem[]) => {
    if (!payload.delivery_lat || !payload.delivery_lng) throw new ValidationError('Titik lokasi pengiriman wajib diisi');
    return getStoreDeliveryOptions({
        store_id: storeId, lat: Number(payload.delivery_lat), lng: Number(payload.delivery_lng), items,
        // Paxel is only offered to whitelisted numbers.
        customer_phone: payload.customer_phone,
    })
        .catch(err => {
            console.error('[Biteship] delivery quote failed:', err?.message ?? err);
            throw new UpstreamError('Ongkir tidak bisa dihitung saat ini. Silakan coba lagi atau pilih metode pengambilan lain.');
        });
};

/**
 * Store delivery (always available; Paxel only for PAXEL_WHITELIST): re-quotes the courier
 * the customer picked server-side — the fee is never trusted from the client — so the customer is
 * charged for, and the store books, exactly that courier.
 */
const resolveStoreDelivery = async (storeId: number, payload: CreateOrderPayload, items: PricedOrderItem[]): Promise<DeliveryQuote | null> => {
    if (payload.delivery_method !== 'store_delivery') return null;
    if (!isStoreDeliveryAllowed(payload.customer_phone)) throw new ValidationError(DELIVERY_UNAVAILABLE);
    if (!payload.delivery_address?.trim()) throw new ValidationError('Alamat pengiriman wajib diisi');
    if (!payload.delivery_courier_company || !payload.delivery_courier_type) throw new ValidationError('Kurir pengiriman wajib dipilih');

    const options = await deliveryOptionsFor(storeId, payload, items);
    const chosen = options.find(o => o.courier_company === payload.delivery_courier_company && o.courier_type === payload.delivery_courier_type);
    if (!chosen) throw new ConflictError('MOHON MAAF: Kurir yang dipilih sedang tidak tersedia. Silakan cek ongkir lagi dan pilih kurir lain.');
    return { fee: chosen.price, courier_company: chosen.courier_company, courier_type: chosen.courier_type };
};

/** Prices each item at the store (most expensive flavor; validates that every flavor has a price). */
const priceItems = async (storeId: number, items: ValidOrderItem[]): Promise<PricedOrderItem[]> => {
    const prices = await priceOrderItems(storeId, items);
    return items.map((item, i) => ({ ...item, ...prices[i] }));
};

/** Inserts order_items (+ their order_item_variants) for an order inside an open transaction. */
const insertOrderItems = async (client: PoolClient, orderId: number, items: PricedOrderItem[]) => {
    for (const item of items) {
        const { rows: [row] } = await client.query(
            'INSERT INTO order_items (order_id, box_type, name, qty, unit_price, price_variant_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [orderId, item.box_type, item.name, item.qty, item.unit_price, item.price_variant_id]
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

/** Couriers (with fees) the customer can pick for store delivery — what createOrder will charge. */
export const storeDeliveryOptionsForOrder = async (payload: Pick<CreateOrderPayload,
    'store_id' | 'pesanan' | 'customer_phone' | 'delivery_lat' | 'delivery_lng'>) => {
    if (!isStoreDeliveryAllowed(payload.customer_phone)) throw new ValidationError(DELIVERY_UNAVAILABLE);
    const store_id = validateStoreId(payload.store_id);
    await assertStoreOpenForOrders(store_id);
    const pesanan = await priceItems(store_id, validateOrderItems(payload.pesanan));
    return deliveryOptionsFor(store_id, payload, pesanan);
};

/** The store's courier can't collect cash, so store-delivery orders must be paid up front. */
const assertPaymentAllowedForDelivery = (payment_method: string | null | undefined, delivery_method: string | null | undefined) => {
    if (payment_method === 'CASH' && delivery_method === 'store_delivery') {
        throw new ValidationError('Pembayaran tunai tidak tersedia untuk Store Delivery');
    }
};

/** "HH:mm" (one moment), as opposed to a range like "11:00 - 16:00": only a moment belongs to an hourly slot. */
const isSingleTime = (time: string | null | undefined): time is string => !!time && /^\d{2}:\d{2}$/.test(time);

/**
 * The store's opening hour and last pickup time, and (unless allowPast, for staff) no time that has
 * already gone by today (review 2026-10-19, M3). The order form disables these too; this is the check.
 */
const assertPickupTimeAllowed = async (storeId: number, date: string, time: string | null | undefined, { allowPast = false } = {}) => {
    if (!time) return;
    const hourStr = time.split(':')[0] + ':00';
    const { rows: [store] } = await pool.query('SELECT open_time, last_pickup_time FROM stores WHERE id = $1', [storeId]);
    if (store?.open_time && hourStr < store.open_time) {
        throw new ConflictError(`MOHON MAAF: Toko baru buka jam ${store.open_time}. Silakan pilih jam lain.`);
    }
    if (store?.last_pickup_time && time.slice(0, 5) > store.last_pickup_time) {
        throw new ConflictError(`MOHON MAAF: Pengambilan paling lambat jam ${store.last_pickup_time}. Silakan pilih jam lain.`);
    }
    if (!allowPast && date === todayWIB() && time.slice(0, 5) < nowTimeWIB()) {
        throw new ConflictError('MOHON MAAF: Jam pengambilan sudah lewat. Silakan pilih jam lain.');
    }
};

/**
 * `staff`: the order is entered by logged-in staff (the /orders form), who may book a time that has
 * already passed today (e.g. a walk-in customer).
 */
export const createOrder = async (payload: CreateOrderPayload, options: { staff?: boolean } = {}) => {
    const { payment_method, delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id } = payload;

    // Validate everything before touching Redis: a negative qty would otherwise
    // *increase* the remaining quota via incrbyfloat.
    const store_id = validateStoreId(payload.store_id);
    await assertStoreOpenForOrders(store_id);
    const customer_name = validateCustomerName(payload.customer_name);
    const customer_phone = validatePhone(payload.customer_phone);
    const validItems = validateOrderItems(payload.pesanan);
    assertVariantIdsGiven(validItems);
    const pickup_date = validatePickupDate(payload.pickup_date);
    const pickup_time = validatePickupTime(payload.pickup_time);
    const note = validateNote(payload.note);
    assertPaymentAllowedForDelivery(payment_method, delivery_method);
    await assertPickupTimeAllowed(store_id, pickup_date, pickup_time, { allowPast: options.staff });
    await assertBoxesAvailable(store_id, validItems);
    await assertVariantSelections(validItems);
    // Prices and names come from the chosen flavors, never from the client.
    const pesanan = await priceItems(store_id, await nameItemsByVariants(validItems));
    const delivery = await resolveStoreDelivery(store_id, payload, pesanan);

    const requestedBoxQty = boxUnits(pesanan);

    // --- 1. DAILY QUOTA VALIDATION (REDIS ATOMIC DECREMENT) ---
    // If no requested items, skip
    let reservedBox = false;
    let reservedHourlyBox = false;
    let hourStr = '';

    try {
        if (requestedBoxQty > 0) {
            await ensureDailyQuotaKey(store_id, pickup_date);
            const remainingBoxStr = await redis.incrbyfloat(redisKeys.dailyQuota(store_id, pickup_date), -requestedBoxQty);
            const remainingBox = parseFloat(remainingBoxStr as unknown as string);
            if (remainingBox < 0) {
                // Revert atomic decrement if we've gone below zero
                await redis.incrbyfloat(redisKeys.dailyQuota(store_id, pickup_date), requestedBoxQty);
                throw new ConflictError(`MOHON MAAF: Kuota Box untuk tanggal ${pickup_date} sudah penuh.`);
            }
            reservedBox = true;
        }

        // --- 2. HOURLY QUOTA VALIDATION (REDIS ATOMIC DECREMENT) ---
        // Runs against the plain pool (read-only queries), kept OUTSIDE the order DB
        // transaction so that Postgres connection is not held open during Redis round-trips.
        // Store hours were checked above (assertPickupTimeAllowed). A range ("11:00 - 16:00") or no time
        // belongs to no hourly slot — the same rule as syncHourlyRedisQuota (review 2026-10-19, M5).
        if (isSingleTime(pickup_time)) {
            hourStr = pickup_time.split(':')[0] + ':00';

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
                const rHourlyBox = await redis.get(redisKeys.hourlyQuota(store_id, pickup_date, hourStr));

                if (rHourlyBox === null) {
                    const usedHourlyRes = await pool.query(`
                        SELECT
                            COALESCE(SUM(${BOX_UNITS_SQL}), 0) as used_box
                        FROM order_items oi
                        JOIN orders o ON oi.order_id = o.id
                        WHERE o.pickup_date = $1
                        AND o.store_id = $2
                        AND o.pickup_time ~ $3
                        AND o.status != 'CANCELLED'
                    `, [pickup_date, store_id, `^${pickup_time.split(':')[0]}:[0-9]{2}$`]);
                    const usedHourlyBox = parseFloat(usedHourlyRes.rows[0].used_box);
                    await redis.set(redisKeys.hourlyQuota(store_id, pickup_date, hourStr), remainingQuota(maxHourly, usedHourlyBox), { nx: true, ex: ttlUntilDate(pickup_date) });
                }

                // Perform Atomic Decrements for Hourly
                if (requestedBoxQty > 0) {
                    const remainingHourlyBoxStr = await redis.incrbyfloat(redisKeys.hourlyQuota(store_id, pickup_date, hourStr), -requestedBoxQty);
                    const remainingHourlyBox = parseFloat(remainingHourlyBoxStr as unknown as string);
                    if (remainingHourlyBox < 0) {
                        await redis.incrbyfloat(redisKeys.hourlyQuota(store_id, pickup_date, hourStr), requestedBoxQty);
                        throw new ConflictError(`MOHON MAAF: Kuota Jam ${hourStr} di tanggal ${pickup_date} sudah penuh. Silakan pilih jam lain.`);
                    }
                    reservedHourlyBox = true;
                }
            }
        }

        // --- 3. INSERT ORDER (short transaction: just the writes) ---
        const created = await transaction(async (client) => {
            // Serialize order creation with store closure; closeStoreForOrders locks this row too.
            const storeState = await client.query('SELECT is_open_for_orders FROM stores WHERE id = $1 FOR UPDATE', [store_id]);
            if (!storeState.rows[0]) throw new NotFoundError(`Store dengan id ${store_id} tidak ditemukan`);
            if (storeState.rows[0].is_open_for_orders === false) throw new ConflictError('Toko sedang tutup dan belum menerima order baru.');
            const orderRes = await client.query(`
            INSERT INTO orders (
                customer_name, customer_phone, pickup_date, pickup_time, note, status, payment_method, store_id,
                delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id,
                delivery_fee, delivery_courier_company, delivery_courier_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING *
        `, [
                customer_name,
                customer_phone,
                pickup_date,
                // No time = no time (the column default '11:00 - 16:00' used to land in the 11:00 slot).
                pickup_time ?? null,
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
                delivery?.fee ?? null,
                delivery?.courier_company ?? null,
                delivery?.courier_type ?? null,
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
            await redis.incrbyfloat(redisKeys.dailyQuota(store_id, pickup_date), requestedBoxQty);
        }

        // Also rollback hourly quotas if they were reserved and then DB failed
        if (reservedHourlyBox && hourStr) {
            await redis.incrbyfloat(redisKeys.hourlyQuota(store_id, pickup_date, hourStr), requestedBoxQty);
        }

        throw e;
    }
};
// Order row + items: [{ id, box_type, name, qty }] — the shape the supabase-js embed returned.
const ORDER_WITH_ITEMS_COLUMNS = `
    o.*,
    -- Raw-material cost booked for this order (fixed at deduction time; NULL = nothing priced).
    (SELECT SUM(-sh.qty_change * sh.unit_cost) FROM stock_history sh WHERE sh.order_id = o.id) AS stock_cost,
    COALESCE(
        json_agg(json_build_object('id', oi.id, 'box_type', oi.box_type, 'name', oi.name, 'qty', oi.qty,
                                   'unit_price', oi.unit_price, 'price_variant_id', oi.price_variant_id) ORDER BY oi.id)
            FILTER (WHERE oi.id IS NOT NULL),
        '[]'
    ) AS items,
    -- Box prices are snapshotted on the items when the order is created or edited.
    COALESCE(SUM(oi.qty * oi.unit_price), 0) AS total_amount`;

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
    if (filters?.from) {
        params.push(filters.from);
        where.push(`o.pickup_date >= $${params.length}::date`);
    }
    if (filters?.to) {
        params.push(filters.to);
        where.push(`o.pickup_date <= $${params.length}::date`);
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

/**
 * Allowed status changes (review 2026-10-19, M8). A cancelled order is reopened to UNPAID first (stock
 * and quota are taken again, then it follows the normal flow); a DONE order can be corrected back to
 * CONFIRMED or cancelled, but not to unpaid/paid.
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    UNPAID: ['PAID', 'CONFIRMED', 'DONE', 'CANCELLED'],
    PAID: ['UNPAID', 'CONFIRMED', 'DONE', 'CANCELLED'],
    CONFIRMED: ['PAID', 'DONE', 'CANCELLED'],
    DONE: ['CONFIRMED', 'CANCELLED'],
    CANCELLED: ['UNPAID'],
};

const statusTransitionMessage = (from: string, to: string) => from === 'CANCELLED'
    ? `Order yang sudah CANCELLED tidak bisa langsung jadi ${to}. Buka ulang ke UNPAID dulu.`
    : `Status ${from} tidak bisa diubah ke ${to}.`;

export const updateOrderStatus = async (id: number, status: string) => (await changeOrderStatus(id, status)).order;

/**
 * Status update that also reports the previous status, so callers can run change-only side effects.
 * `expectedStatus`: only change an order that is still in that status (ConflictError otherwise), so
 * e.g. an automatic cancel never overwrites a payment that landed in the meantime.
 */
export const changeOrderStatus = async (id: number, status: string, options: { expectedStatus?: OrderStatus } = {}) => {
    const upperStatus = status.toUpperCase();

    if (!VALID_STATUSES.includes(upperStatus as OrderStatus)) {
        throw new ValidationError(`Status tidak valid. Pilihan: ${VALID_STATUSES.join(', ')}`);
    }

    const oldOrder = await getOrderById(id);
    if (options.expectedStatus && oldOrder.status !== options.expectedStatus) {
        throw new ConflictError(`Order #${id} sudah tidak berstatus ${options.expectedStatus}`);
    }
    if (oldOrder.status === upperStatus) {
        // Nothing changes (double click, retried request): no side effects a second time.
        const { rows: [current] } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        return { order: current, previousStatus: oldOrder.status as string };
    }
    if (!STATUS_TRANSITIONS[oldOrder.status as OrderStatus]?.includes(upperStatus as OrderStatus)) {
        throw new ConflictError(statusTransitionMessage(oldOrder.status, upperStatus));
    }

    // Only from the status the checks above saw: a concurrent change makes this a no-op → 409.
    const { rows } = await pool.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = $3 RETURNING *',
        [upperStatus, id, oldOrder.status]
    );
    const data = rows[0];
    if (!data && options.expectedStatus) throw new ConflictError(`Order #${id} sudah tidak berstatus ${options.expectedStatus}`);
    if (!data) throw new ConflictError(`Status order #${id} baru saja berubah. Muat ulang lalu coba lagi.`);

    const wasCancelled = oldOrder.status === 'CANCELLED';
    const isCancelled = upperStatus === 'CANCELLED';

    // Cancelling gives the order's boxes back to the quota, un-cancelling takes them again.
    if (oldOrder.pickup_date && wasCancelled !== isCancelled) {
        const units = boxUnits(oldOrder.items);
        await adjustQuota(oldOrder.store_id, oldOrder.pickup_date, oldOrder.pickup_time, isCancelled ? units : -units);
    }

    // K1: cancelling gives the raw materials back; un-cancelling takes them again.
    if (!wasCancelled && isCancelled) await reverseOrderStockSafe(id);
    if (wasCancelled && !isCancelled) await applyOrderStockSafe(id);

    // A cancelled store-delivery order must not keep a courier on its way (H6). Never throws.
    if (isCancelled && oldOrder.delivery_method === 'store_delivery') {
        await cancelActiveDeliveries(id).catch(err => console.error(`[Biteship] cancel for Order #${id} failed:`, err?.message ?? err));
    }

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

/**
 * Moves an order's boxes in or out of the live Redis counters (+units = give back, −units = take).
 * A delta instead of recounting from the DB: a recount would wipe the reservation of an order that is
 * being created right now (Redis already decremented, row not committed yet) and let the slot be sold
 * twice (review 2026-10-19, L1). A counter that doesn't exist yet is left alone — it is built from the
 * DB the first time it is needed. Never throws.
 */
const adjustQuota = async (storeId: number, date: string, time: string | null | undefined, units: number) => {
    if (!units) return;
    const keys = [redisKeys.dailyQuota(storeId, date)];
    if (isSingleTime(time)) keys.push(redisKeys.hourlyQuota(storeId, date, `${time.slice(0, 2)}:00`));
    for (const key of keys) {
        try {
            if (await redis.exists(key)) await redis.incrbyfloat(key, units);
        } catch (err) {
            console.error(`[quota] could not adjust ${key} by ${units}:`, err);
        }
    }
};

/** Box units of the store's other live orders on a date (optionally only those in one hour slot "HH"). */
const unitsTakenByOthers = async (storeId: number, date: string, orderId: number, hour?: string) => {
    const { rows: [row] } = await pool.query(`
        SELECT COALESCE(SUM(${BOX_UNITS_SQL}), 0) AS used
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.store_id = $1 AND o.pickup_date = $2 AND o.status != 'CANCELLED' AND o.id <> $3
          AND ($4::text IS NULL OR o.pickup_time ~ ('^' || $4::text || ':[0-9]{2}$'))
    `, [storeId, date, orderId, hour ?? null]);
    return parseFloat(row.used);
};

/**
 * An admin edit (more boxes, another date or time) must fit the same limits as a new order: the date
 * is open, the daily and hourly quota have room, and the time is within store hours
 * (review 2026-10-19, L3). Times that already passed are fine for staff. Unchanged edits are not
 * re-checked, so an already full day can still get its note or name fixed.
 */
const assertEditFits = async (old: any, next: { date: string; time: string | null | undefined; units: number }) => {
    const dateChanged = next.date !== old.pickup_date;
    const timeChanged = (next.time ?? null) !== (old.pickup_time ?? null);
    const moreBoxes = next.units > boxUnits(old.items);
    if (!dateChanged && !timeChanged && !moreBoxes) return;

    if (timeChanged || dateChanged) await assertPickupTimeAllowed(old.store_id, next.date, next.time, { allowPast: true });

    if (dateChanged || moreBoxes) {
        const { rows: [quota] } = await pool.query('SELECT qty FROM daily_quota WHERE store_id = $1 AND date = $2::date', [old.store_id, next.date]);
        if (!quota && dateChanged) throw new ValidationError(`MOHON MAAF: Tanggal ${next.date} belum dibuka untuk pemesanan.`);
        if (quota && (await unitsTakenByOthers(old.store_id, next.date, old.id)) + next.units > parseFloat(quota.qty)) {
            throw new ConflictError(`MOHON MAAF: Kuota Box untuk tanggal ${next.date} sudah penuh.`);
        }
    }

    if (isSingleTime(next.time)) {
        const hour = next.time.slice(0, 2);
        const { rows: [slot] } = await pool.query(
            'SELECT qty FROM hourly_quota WHERE store_id = $1 AND time_str = $2 AND is_active = true', [old.store_id, `${hour}:00`]);
        if (slot && (await unitsTakenByOthers(old.store_id, next.date, old.id, hour)) + next.units > parseFloat(slot.qty)) {
            throw new ConflictError(`MOHON MAAF: Kuota Jam ${hour}:00 di tanggal ${next.date} sudah penuh. Silakan pilih jam lain.`);
        }
    }
};

export const updateOrder = async (id: number, payload: UpdateOrderPayload) => {
    const { payment_method } = payload;
    const oldOrder = await getOrderById(id);
    assertPaymentAllowedForDelivery(payment_method, oldOrder.delivery_method);

    // Admin edits may keep an order's existing (possibly past) date, but a changed
    // date must follow the same rules as a new order.
    const customer_name = payload.customer_name === undefined ? undefined : validateCustomerName(payload.customer_name);
    const validItems = payload.pesanan && payload.pesanan.length > 0 ? validateOrderItems(payload.pesanan) : undefined;
    const pickup_date = payload.pickup_date === undefined
        ? undefined
        : validatePickupDate(payload.pickup_date, { allowPast: payload.pickup_date === oldOrder?.pickup_date });
    const pickup_time = payload.pickup_time === undefined || payload.pickup_time === null
        ? payload.pickup_time
        : (validatePickupTime(payload.pickup_time) ?? null);
    const note = validateNote(payload.note);
    let pesanan: PricedOrderItem[] | undefined;
    if (validItems && oldOrder.payment_method === 'DOKU' && oldOrder.status === 'UNPAID' && oldOrder.doku_invoice_number) {
        // The customer pays the amount of the existing DOKU checkout; a new total would make that payment
        // fail the amount check and leave the order UNPAID (review 2026-10-19, H5).
        throw new ConflictError('Item order DOKU yang belum dibayar tidak bisa diubah. Batalkan order ini dan buat order baru.');
    }
    if (validItems) {
        await assertBoxesAvailable(oldOrder.store_id, validItems);
        await assertVariantSelections(validItems);
        // Edited items are priced (and named) again from today's flavors and prices.
        pesanan = await priceItems(oldOrder.store_id, await nameItemsByVariants(validItems));
    }

    if (oldOrder.status !== 'CANCELLED') {
        await assertEditFits(oldOrder, {
            date: pickup_date ?? oldOrder.pickup_date,
            time: pickup_time !== undefined ? pickup_time : oldOrder.pickup_time,
            units: pesanan ? boxUnits(pesanan) : boxUnits(oldOrder.items),
        });
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

    // Quota: give back what the order held (old date/time/boxes) and take what it holds now. A cancelled
    // order holds nothing either way.
    if (oldOrder.status !== 'CANCELLED' && oldOrder.pickup_date) {
        await adjustQuota(oldOrder.store_id, oldOrder.pickup_date, oldOrder.pickup_time, boxUnits(oldOrder.items));
        await adjustQuota(oldOrder.store_id, order.pickup_date, order.pickup_time, -(pesanan ? boxUnits(pesanan) : boxUnits(oldOrder.items)));
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
        total_amount: Number(order.total_amount),
        delivery_fee: order.delivery_fee === null || order.delivery_fee === undefined ? null : Number(order.delivery_fee),
        // DOKU checkout link, only while it can still be paid.
        payment_url: order.payment_method === 'DOKU' && order.status === 'UNPAID'
            && (!order.doku_expired_at || new Date(order.doku_expired_at) > new Date())
            ? order.doku_payment_url ?? null
            : null,
        payment_expired_at: order.doku_expired_at ?? null,
        items: order.items.map((i: { box_type: string; name: string; qty: number; unit_price: number | null }) => ({
            box_type: i.box_type, name: i.name, qty: i.qty, unit_price: i.unit_price === null ? null : Number(i.unit_price),
        })),
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
    if (payment_method === 'CASH') {
        const { rows: [order] } = await pool.query('SELECT delivery_method FROM orders WHERE id = $1', [id]);
        if (order) assertPaymentAllowedForDelivery(payment_method, order.delivery_method);
    }
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
