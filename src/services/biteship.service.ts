import { createHash, timingSafeEqual } from 'node:crypto';
import { pool } from '../config/db';
import { biteshipGet, biteshipPost } from '../utils/biteship';
import { getStoreById } from './store.service';
import { getMenuBoxMap, boxShippingItem } from './menu.service';
import { boxLabel } from '../utils/boxLabel';
import { FINAL_ATTEMPT_STATUSES, nextAttemptStatus, providerStatusNote } from '../utils/deliveryAttempt';
import { isOutsideJabodetabek } from '../utils/deliveryArea';
import { PAXEL_COURIER, PAXEL_SERVICE, isPaxelAllowed, withoutDimensions } from '../utils/paxel';
import { startRecurringJob } from '../utils/recurringJob';
import { ConflictError, NotFoundError } from '../utils/errors';
import { ValidationError } from '../utils/validation';
import { sendPushToAll } from './push.service';
// import { formatWAPhone } from '../utils/phone'; // used by the (disabled) BITESHIP_WHITELIST check

/**
 * Store Delivery via Biteship is always on (quotes + courier booking) — BITESHIP_ENABLED is no longer
 * read. Kept as a function so it can be switched back to the env flag.
 */
export const isBiteshipEnabled = () => true;
// export const isBiteshipEnabled = () => process.env.BITESHIP_ENABLED === 'true';

// BITESHIP_WHITELIST is no longer checked: every customer may pick Store Delivery.
// /** BITESHIP_WHITELIST: comma-separated phone numbers (any format) — empty means every customer. */
// const biteshipWhitelist = () =>
//     (process.env.BITESHIP_WHITELIST || '').split(',').map(p => formatWAPhone(p.trim())).filter(Boolean);

/** Whether this customer may pick Store Delivery: always (no whitelist). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const isStoreDeliveryAllowed = (_phone: string | null | undefined) => isBiteshipEnabled();
// export const isStoreDeliveryAllowed = (phone: string | null | undefined) => {
//     if (!isBiteshipEnabled()) return false;
//     const whitelist = biteshipWhitelist();
//     return whitelist.length === 0 || (!!phone && whitelist.includes(formatWAPhone(phone)));
// };

// Couriers asked for rates when the client doesn't specify any (instant + same-day coverage).
export const DEFAULT_RATE_COURIERS = 'gosend,grab,gojek,lalamove,paxel,borzo,sicepat,anteraja,jne,jnt';

/**
 * Store delivery services the customer can choose from. All are booked with delivery_type "now"
 * when the order is DONE (ready), so the driver comes when the order is ready. Paxel Small is offered
 * on top of these, separately (whitelist + outside Jabodetabek, see getStoreDeliveryOptions).
 */
const COURIER_SERVICES: Record<string, string> = {
    grab: 'instant',
    gojek: 'instant',
    lalamove: 'motorcycle',
};

/** SELECTED_COURIER: the couriers offered (comma-separated, e.g. "lalamove"); empty → all of COURIER_SERVICES. */
const offeredCouriers = () => {
    const wanted = (process.env.SELECTED_COURIER || '').split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
    const known = wanted.filter(c => COURIER_SERVICES[c]);
    if (wanted.length > known.length) console.warn(`[Biteship] unknown SELECTED_COURIER entries ignored: ${wanted.filter(c => !COURIER_SERVICES[c]).join(', ')}`);
    return known.length > 0 ? known : Object.keys(COURIER_SERVICES);
};

/** One courier the customer can pick, with the fee breakdown Biteship returns. */
export interface DeliveryOption {
    courier_company: string;   // Biteship courier_code, e.g. lalamove
    courier_type: string;      // Biteship courier_service_code, e.g. motorcycle
    courier_name: string;
    service_name: string;
    duration: string | null;
    /** What the customer pays for delivery. */
    price: number;
    shipping_fee: number;
    shipping_fee_discount: number;
    shipping_fee_surcharge: number;
}

export interface DeliveryQuote {
    fee: number;
    courier_company: string;
    courier_type: string;
}

/** Rates of the offered couriers from the store to the destination, cheapest first. */
export const getStoreDeliveryOptions = async (params: {
    store_id: number;
    lat: number;
    lng: number;
    items: { box_type: string; name: string; qty: number; unit_price: number | null }[];
    /** Decides whether Paxel is offered (PAXEL_WHITELIST). */
    customer_phone?: string | null;
}): Promise<DeliveryOption[]> => {
    const store = await getStoreById(params.store_id);
    const boxes = await getMenuBoxMap();
    const couriers = offeredCouriers();
    const items = params.items.map(item => ({
        name: `${boxLabel(item.box_type)} - ${item.name}`,
        ...boxShippingItem(boxes.get(item.box_type), item.box_type),
        ...(item.unit_price != null ? { value: Number(item.unit_price) } : {}),
        quantity: item.qty,
    }));
    const rates = (rateCouriers: string, rateItems: unknown[]) => biteshipPost('/rates/couriers', {
        origin_latitude: Number(store.latitude),
        origin_longitude: Number(store.longitude),
        destination_latitude: params.lat,
        destination_longitude: params.lng,
        couriers: rateCouriers,
        items: rateItems,
    });
    const withPaxel = isPaxelAllowed(params.customer_phone);
    let instantError: unknown = null;
    const [data, paxel]: any[] = await Promise.all([
        // Outside the instant couriers' range Biteship rejects this call ("No courier available …");
        // for a Paxel customer that must not hide Paxel, so the error is held until Paxel is known.
        withPaxel
            ? rates(couriers.join(','), items).catch(err => { instantError = err; return null; })
            : rates(couriers.join(','), items),
        // Whitelisted customers also get Paxel Small, quoted without box dimensions. A failed Paxel
        // quote never hides the other couriers.
        withPaxel
            ? rates(PAXEL_COURIER, items.map(withoutDimensions)).catch(err => {
                console.error('[Biteship] Paxel quote failed:', err?.message ?? err);
                return null;
            })
            : null,
    ]);
    const paxelRates = paxel && isOutsideJabodetabek(paxel.destination)
        ? ((paxel.pricing ?? []) as any[]).filter(r => r.courier_code === PAXEL_COURIER && r.courier_service_code === PAXEL_SERVICE)
        : [];
    if (instantError) {
        if (paxelRates.length === 0) throw instantError;
        console.warn('[Biteship] instant couriers unavailable, offering Paxel only:', (instantError as Error)?.message ?? instantError);
    }
    return ((data?.pricing ?? []) as any[])
        // courier_code / courier_service_code are what POST /orders expects as courier_company / courier_type.
        .filter(r => couriers.includes(r.courier_code) && COURIER_SERVICES[r.courier_code] === r.courier_service_code)
        .concat(paxelRates)
        .filter(r => Number(r.price) > 0)
        .map(r => ({
            courier_company: r.courier_code,
            courier_type: r.courier_service_code,
            courier_name: r.courier_name ?? r.courier_code,
            service_name: r.courier_service_name ?? r.courier_service_code,
            duration: r.duration ?? null,
            price: Number(r.price),
            shipping_fee: Number(r.shipping_fee ?? r.price),
            shipping_fee_discount: Number(r.shipping_fee_discount ?? 0),
            shipping_fee_surcharge: Number(r.shipping_fee_surcharge ?? 0),
        }))
        .sort((a, b) => a.price - b.price);
};

type DispatchResult =
    | { status: 'created'; biteship_order_id: string; tracking_link: string | null; attempt_id?: number }
    | { status: 'skipped'; reason: string };

const claimDispatch = async (order: any, retry = false, confirmUncertain = false) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT id, biteship_order_id FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
        if (!locked.rowCount) throw new NotFoundError(`Order #${order.id} tidak ditemukan`);
        const { rows: previous } = await client.query(
            'SELECT * FROM order_delivery_attempts WHERE order_id = $1 ORDER BY attempt_no DESC LIMIT 1', [order.id]
        );
        const last = previous[0];
        const uncertainPrevious = last?.status === 'PENDING' && String(last.failure_message ?? '').startsWith('HASIL BELUM PASTI:');
        if (uncertainPrevious && retry && confirmUncertain) {
            await client.query("UPDATE order_delivery_attempts SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [last.id]);
        } else if (last && ['PENDING', 'ALLOCATED'].includes(last.status)) {
            await client.query('COMMIT');
            if (retry) throw new ConflictError('Percobaan pengiriman sebelumnya masih aktif. Perbarui statusnya sebelum membuat ulang.');
            return null;
        }
        if (!retry && locked.rows[0].biteship_order_id && !['UNKNOWN', 'PENDING'].includes(locked.rows[0].biteship_order_id)) {
            await client.query('COMMIT');
            return null;
        }
        if (retry && last && !['FAILED', 'CANCELLED'].includes(last.status) && !(uncertainPrevious && confirmUncertain)) {
            await client.query('COMMIT');
            throw new ConflictError('Retry hanya tersedia untuk percobaan yang gagal atau dibatalkan.');
        }
        const attemptNo = Number(last?.attempt_no ?? 0) + 1;
        const { rows } = await client.query(`
            INSERT INTO order_delivery_attempts (order_id, attempt_no, status, courier_company, courier_type)
            VALUES ($1, $2, 'PENDING', $3, $4) RETURNING *
        `, [order.id, attemptNo, order.delivery_courier_company || 'grab', order.delivery_courier_type || 'instant']);
        await client.query("UPDATE orders SET biteship_order_id = 'PENDING', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [order.id]);
        await client.query('COMMIT');
        return rows[0];
    } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
    } finally {
        client.release();
    }
};

/** Falls back to the postal code in the address when the order has no Biteship area id. */
const resolveAreaId = async (order: any): Promise<string | null> => {
    if (order.delivery_area_id) return order.delivery_area_id;
    const postalMatch = String(order.delivery_address ?? '').match(/\b\d{5}\b/);
    if (!postalMatch) return null;
    try {
        const areaData: any = await biteshipGet(`/maps/areas?countries=ID&input=${postalMatch[0]}&type=single`);
        const areaId = areaData?.areas?.[0]?.id ?? null;
        if (areaId) console.log(`[Biteship] Auto-resolved area_id ${areaId} for Order #${order.id}`);
        return areaId;
    } catch (e) {
        console.error(`[Biteship] Failed to auto-resolve area_id for Order #${order.id}`, e);
        return null;
    }
};

/**
 * Books the courier for a store-delivery order that is DONE (ready to ship), at most once per order.
 * Always delivery_type "now": the driver is called when the order is ready (Lalamove can't be scheduled).
 * `order` is the full order as returned by getOrderById (with items).
 */
export const createBiteshipDispatch = async (order: any, options: { retry?: boolean; confirmUncertain?: boolean } = {}): Promise<DispatchResult> => {
    if (order.delivery_method !== 'store_delivery') return { status: 'skipped', reason: 'not store_delivery' };
    if (!isBiteshipEnabled()) {
        console.warn(`[Biteship] BITESHIP_ENABLED is off — courier for Order #${order.id} not booked.`);
        return { status: 'skipped', reason: 'biteship disabled' };
    }
    const attempt = await claimDispatch(order, options.retry, options.confirmUncertain);
    if (!attempt) return { status: 'skipped', reason: 'already dispatched' };

    let providerAccepted = false;
    let acceptedOrderId: string | null = null;
    try {
        if (!order.delivery_address || !order.delivery_lat || !order.delivery_lng) {
            throw new ValidationError('Alamat atau koordinat pengiriman order tidak lengkap.');
        }
        // Optional for instant couriers: they go by destination_coordinate (addresses picked via Google
        // search often have no postal code to resolve an area from).
        const areaId = await resolveAreaId(order);

        const originStore = order.store_id ? await getStoreById(order.store_id) : null;
        if (!originStore) {
            throw new ValidationError(`Toko asal order #${order.id} tidak ditemukan.`);
        }

        const boxes = await getMenuBoxMap();

        const payload: Record<string, any> = {
            // Shipper = toko asal (per store_id order ini)
            shipper_contact_name: originStore.name,
            shipper_contact_phone: originStore.phone,
            // Origin = toko asal
            origin_contact_name: originStore.name,
            origin_contact_phone: originStore.phone,
            origin_address: originStore.address,
            origin_area_id: originStore.area_id,
            origin_coordinate: { latitude: Number(originStore.latitude), longitude: Number(originStore.longitude) },
            // Destination
            destination_contact_name: order.customer_name,
            destination_contact_phone: order.customer_phone,
            destination_address: order.delivery_address,
            ...(areaId ? { destination_area_id: areaId } : {}),
            destination_coordinate: { latitude: Number(order.delivery_lat), longitude: Number(order.delivery_lng) },
            ...(order.delivery_driver_note ? { destination_note: order.delivery_driver_note } : {}),
            // The courier the delivery fee was quoted for; older orders default to grab instant.
            courier_company: order.delivery_courier_company || 'grab',
            courier_type: order.delivery_courier_type || 'instant',
            delivery_type: 'now',
            items: (order.items || []).map((item: any) => {
                const shippingItem = {
                    name: `${boxLabel(item.box_type)} - ${item.name}`,
                    description: `RPN ${item.box_type}`,
                    ...boxShippingItem(boxes.get(item.box_type), item.box_type),
                    // Declared value = the box price actually charged.
                    ...(item.unit_price != null ? { value: Number(item.unit_price) } : {}),
                    quantity: item.qty,
                };
                // Paxel is booked the way it was quoted: without box dimensions.
                return order.delivery_courier_company === PAXEL_COURIER ? withoutDimensions(shippingItem) : shippingItem;
            }),
            order_note: `RPN Order #${order.id}${order.note ? ` - ${order.note}` : ''}`,
        };

        const created: any = await biteshipPost('/orders', payload);
        providerAccepted = true;
        const biteshipOrderId = String(created?.id ?? created?.order_id ?? 'UNKNOWN');
        acceptedOrderId = biteshipOrderId === 'UNKNOWN' ? null : biteshipOrderId;
        const trackingLink = created?.courier?.link ?? created?.tracking_link ?? null;
        const status = normalizeDeliveryStatus(created?.status ?? created?.courier?.status) ?? 'ALLOCATED';
        await pool.query(`
            UPDATE order_delivery_attempts SET biteship_order_id = $2, status = $3,
                provider_status = $4, tracking_link = $5, failure_message = $6,
                driver_name = $7, driver_phone = $8, driver_plate_number = $9,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1
        `, [attempt.id, biteshipOrderId === 'UNKNOWN' ? null : biteshipOrderId, status,
            created?.status ?? null, trackingLink, status === 'FAILED' ? `Biteship menolak alokasi: ${created?.status ?? 'gagal'}` : null,
            created?.courier?.driver_name ?? created?.courier?.name ?? null,
            created?.courier?.driver_phone ?? created?.courier?.phone ?? null,
            created?.courier?.driver_plate_number ?? null]);
        await pool.query('UPDATE orders SET biteship_order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [order.id, biteshipOrderId]);
        console.log(`[Biteship] Auto-created order ${biteshipOrderId} for RPN #${order.id}`);
        if (status === 'FAILED' || status === 'CANCELLED') notifyInBackground(notifyDeliveryProblem, attempt.id);
        return { status: 'created', biteship_order_id: biteshipOrderId, tracking_link: trackingLink, attempt_id: attempt.id };
    } catch (err) {
        const outcomeUncertain = !providerAccepted && (err instanceof TypeError || (err as any)?.name === 'AbortError');
        const errorMessage = err instanceof Error ? err.message : 'Biteship gagal membuat pengiriman.';
        const failureMessage = outcomeUncertain ? `HASIL BELUM PASTI: ${errorMessage}. Periksa dashboard Biteship sebelum mencoba ulang.` : errorMessage;
        await pool.query(`UPDATE order_delivery_attempts SET status = $2, biteship_order_id = $3, failure_message = $4,
            failure_code = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [attempt.id, providerAccepted || outcomeUncertain ? 'PENDING' : 'FAILED', acceptedOrderId, failureMessage, (err as any)?.code ?? null]).catch(() => undefined);
        await pool.query('UPDATE orders SET biteship_order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND biteship_order_id = \'PENDING\'',
            [order.id, providerAccepted || outcomeUncertain ? (acceptedOrderId ?? 'UNKNOWN') : null]).catch(() => undefined);
        // Failed, or booked-but-unknown: either way an admin has to look at it.
        if (!providerAccepted || outcomeUncertain) notifyInBackground(notifyDeliveryProblem, attempt.id);
        throw err;
    }
};

const normalizeDeliveryStatus = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const compact = raw.toLowerCase().replace(/[_\s-]/g, '');
    if (['delivered'].includes(compact)) return 'DELIVERED';
    if (['couriernotfound', 'rejected', 'failed'].includes(compact)) return 'FAILED';
    if (['cancelled', 'canceled', 'returned', 'disposed'].includes(compact)) return 'CANCELLED';
    if (['allocated', 'pickingup', 'picked', 'intransit', 'droppingoff'].includes(compact)) return 'ALLOCATED';
    if (['confirmed', 'pending', 'onhold'].includes(compact)) return 'PENDING';
    return null;
};

// --- Admin notifications --------------------------------------------------------------------

const COURIER_NAMES: Record<string, string> = {
    grab: 'GrabExpress', gojek: 'GoSend', lalamove: 'Lalamove', borzo: 'Borzo', deliveree: 'Deliveree', paxel: 'Paxel',
};
const courierLabel = (company?: string | null, type?: string | null) => {
    const name = company ? (COURIER_NAMES[company.toLowerCase()] ?? company) : 'Kurir';
    return type ? `${name} ${type.charAt(0).toUpperCase()}${type.slice(1)}` : name;
};
const wibTime = (value: string | Date) =>
    new Date(value).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).replace('.', ':');
const shorten = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The attempt with its order's customer and store, for notification texts. */
const loadAttemptContext = async (attemptId: number) => {
    const { rows } = await pool.query(`
        SELECT a.*, o.customer_name, s.name AS store_name
        FROM order_delivery_attempts a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN stores s ON s.id = o.store_id
        WHERE a.id = $1`, [attemptId]);
    return rows[0];
};

/** "✅ Order #123 sudah sampai" — at most once per attempt. */
export const notifyDeliveryDelivered = async (attemptId: number) => {
    const { rowCount } = await pool.query(`UPDATE order_delivery_attempts SET delivery_notified_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'DELIVERED' AND delivery_notified_at IS NULL`, [attemptId]);
    if (!rowCount) return;
    const a = await loadAttemptContext(attemptId);
    const driver = a.driver_name ? ` · ${a.driver_name}${a.driver_plate_number ? ` (${a.driver_plate_number})` : ''}` : '';
    await sendPushToAll({
        title: `✅ Order #${a.order_id} sudah sampai`,
        body: [
            `Diterima ${a.customer_name} · ${a.store_name ?? 'Toko'}`,
            `Kurir: ${courierLabel(a.courier_company, a.courier_type)}${driver}`,
            `Tiba ${wibTime(a.provider_updated_at ?? new Date())} WIB`,
        ].join('\n'),
        url: `/orders?order=${a.order_id}`,
        tag: `delivery-${a.order_id}`,
    });
};

/** "⚠️ Kurir tidak didapat" (FAILED), "dibatalkan Biteship" (CANCELLED) or "belum pasti" — once per attempt. */
export const notifyDeliveryProblem = async (attemptId: number) => {
    const { rowCount } = await pool.query(`UPDATE order_delivery_attempts SET failure_notified_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND failure_notified_at IS NULL
          AND (status IN ('FAILED', 'CANCELLED') OR failure_message LIKE 'HASIL BELUM PASTI:%')`, [attemptId]);
    if (!rowCount) return;
    const a = await loadAttemptContext(attemptId);
    const headline = a.status === 'CANCELLED'
        ? 'Pengiriman dibatalkan Biteship'
        : a.status === 'FAILED' ? 'Kurir tidak didapat' : 'Booking kurir belum pasti';
    const reason = String(a.failure_message || a.provider_status || 'tanpa keterangan').replace(/^HASIL BELUM PASTI:\s*/, '');
    await sendPushToAll({
        title: `⚠️ ${headline} · Order #${a.order_id}`,
        body: [
            `${a.customer_name} · ${a.store_name ?? 'Toko'} · ${courierLabel(a.courier_company, a.courier_type)} (percobaan ${a.attempt_no})`,
            `Alasan: ${shorten(reason)}`,
            a.status === 'PENDING' ? 'Cek dashboard Biteship sebelum coba ulang.' : 'Buka order untuk coba ulang pengiriman.',
        ].join('\n'),
        url: `/orders?order=${a.order_id}`,
        tag: `delivery-${a.order_id}`,
    });
};

const notifyInBackground = (notify: (attemptId: number) => Promise<void>, attemptId: number) => {
    notify(attemptId).catch(err => console.error(`[Biteship] notification for attempt #${attemptId} failed:`, err?.message ?? err));
};

export const getDeliveryAttempts = async (orderId: number) => {
    const { rows } = await pool.query('SELECT * FROM order_delivery_attempts WHERE order_id = $1 ORDER BY attempt_no DESC', [orderId]);
    return rows;
};

/**
 * Pulls one attempt's status from Biteship (GET /orders/:id). A failure or cancellation keeps Biteship's
 * own explanation (courier.history note, e.g. "Order is rejected because no courier picking up order").
 * Errors are logged, never thrown, so one bad attempt doesn't stop the others.
 */
const refreshAttempt = async (attempt: { id: number; status: string; biteship_order_id: string }) => {
    try {
        const remote: any = await biteshipGet(`/orders/${encodeURIComponent(attempt.biteship_order_id)}`);
        const statusRaw = remote?.status ?? remote?.courier?.status;
        const status = normalizeDeliveryStatus(statusRaw);
        const courier = remote?.courier ?? {};
        const targetStatus = nextAttemptStatus(attempt.status, status);
        await pool.query(`UPDATE order_delivery_attempts SET
            status = COALESCE($2, status), provider_status = COALESCE($3, provider_status),
            tracking_link = COALESCE($4, tracking_link), waybill_id = COALESCE($5, waybill_id),
            driver_name = COALESCE($6, driver_name), driver_phone = COALESCE($7, driver_phone),
            driver_plate_number = COALESCE($8, driver_plate_number), provider_updated_at = CURRENT_TIMESTAMP,
            failure_message = CASE
                WHEN $2::varchar = 'FAILED' THEN COALESCE(failure_message, $9, 'Biteship gagal mengalokasikan kurir.')
                WHEN $2::varchar = 'CANCELLED' THEN COALESCE(failure_message, $9)
                ELSE failure_message END,
            updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`, [attempt.id, targetStatus, statusRaw ?? null,
            courier.link ?? remote?.tracking_link ?? null, courier.waybill_id ?? remote?.waybill_id ?? null,
            courier.driver_name ?? courier.name ?? null, courier.driver_phone ?? courier.phone ?? null,
            courier.driver_plate_number ?? null, providerStatusNote(remote)]);
        if (targetStatus === 'DELIVERED') notifyInBackground(notifyDeliveryDelivered, attempt.id);
        if (targetStatus === 'FAILED' || targetStatus === 'CANCELLED') notifyInBackground(notifyDeliveryProblem, attempt.id);
        return targetStatus !== null && targetStatus !== attempt.status;
    } catch (err) {
        console.error(`[Biteship] refresh attempt #${attempt.id} failed:`, (err as Error)?.message ?? err);
        return false;
    }
};

export const refreshDeliveryAttempts = async (orderId: number) => {
    const attempts = await getDeliveryAttempts(orderId);
    for (const attempt of attempts) {
        if (attempt.biteship_order_id) await refreshAttempt(attempt);
    }
    return getDeliveryAttempts(orderId);
};

/** Only attempts booked in the last day are polled; older ones are left to the Perbarui button. */
const POLL_WINDOW_HOURS = 24;

/**
 * Pulls the status of every open attempt (PENDING/ALLOCATED with a Biteship order) from Biteship, so an
 * allocation failure reaches the admins even when no webhook arrives. Returns how many attempts changed status.
 */
export const pollActiveDeliveryAttempts = async () => {
    const { rows } = await pool.query(`
        SELECT id, status, biteship_order_id FROM order_delivery_attempts
        WHERE status IN ('PENDING', 'ALLOCATED') AND biteship_order_id IS NOT NULL
          AND created_at > CURRENT_TIMESTAMP - make_interval(hours => $1)
        ORDER BY id`, [POLL_WINDOW_HOURS]);
    let changed = 0;
    for (const attempt of rows) {
        if (await refreshAttempt(attempt)) changed++;
    }
    return { checked: rows.length, changed };
};

/** BITESHIP_POLL_MINUTES (default 3; 0 = off): how often pollActiveDeliveryAttempts runs. */
export const startDeliveryStatusPolling = () =>
    startRecurringJob('[Biteship] status polling', 'BITESHIP_POLL_MINUTES', 3, async () => {
        const { checked, changed } = await pollActiveDeliveryAttempts();
        return changed ? `${changed} of ${checked} open attempt(s) changed` : null;
    });

/**
 * The RPN order was cancelled: cancel its open Biteship shipments, so no courier comes and nothing is
 * charged (review 2026-10-19, H6). Never throws; when Biteship refuses (e.g. already picked up) or the
 * booking is uncertain, admins get a push to sort it out in the Biteship dashboard.
 */
export const cancelActiveDeliveries = async (orderId: number) => {
    const { rows } = await pool.query(
        `SELECT id, biteship_order_id FROM order_delivery_attempts WHERE order_id = $1 AND status IN ('PENDING', 'ALLOCATED') ORDER BY id`,
        [orderId]);
    for (const attempt of rows) {
        let problem: string | null = null;
        if (!attempt.biteship_order_id) {
            problem = 'Booking kurir belum pasti, cek dashboard Biteship.';
        } else {
            try {
                await biteshipPost(`/orders/${encodeURIComponent(attempt.biteship_order_id)}/cancel`, {
                    cancellation_reason_code: 'others',
                    cancellation_reason: `Order RPN #${orderId} dibatalkan`,
                });
            } catch (err) {
                problem = `Biteship menolak pembatalan: ${(err as Error)?.message ?? err}`;
            }
        }
        if (problem) {
            console.error(`[Biteship] could not cancel attempt #${attempt.id} of Order #${orderId}:`, problem);
            await sendPushToAll({
                title: `⚠️ Kurir belum dibatalkan · Order #${orderId}`,
                body: `Order dibatalkan, tapi pengiriman Biteship masih aktif. ${shorten(problem)}`,
                url: `/orders?order=${orderId}`,
                tag: `delivery-${orderId}`,
            }).catch(e => console.error('[Biteship] cancel alert failed:', e?.message ?? e));
            continue;
        }
        // failure_notified_at: our own cancellation is no "dibatalkan Biteship" problem for admins.
        await pool.query(`UPDATE order_delivery_attempts SET status = 'CANCELLED', provider_status = 'cancelled',
            failure_message = 'Dibatalkan karena order RPN dibatalkan', failure_notified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [attempt.id]);
    }
};

export const retryBiteshipDispatch = async (orderId: number, confirmUncertain = false) => {
    const { rows } = await pool.query(`
        SELECT o.*, COALESCE(json_agg(json_build_object('box_type', oi.box_type, 'name', oi.name, 'qty', oi.qty,
            'unit_price', oi.unit_price) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
        FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.id = $1 GROUP BY o.id
    `, [orderId]);
    if (!rows[0]) throw new NotFoundError(`Order #${orderId} tidak ditemukan`);
    if (rows[0].delivery_method !== 'store_delivery' || rows[0].status !== 'DONE') {
        throw new ConflictError('Retry Biteship hanya tersedia untuk order Store Delivery berstatus DONE.');
    }
    return createBiteshipDispatch(rows[0], { retry: true, confirmUncertain });
};

/** Validate Biteship's configured custom header and persist a status callback exactly once. */
export const processBiteshipWebhook = async (body: any, rawBody: Buffer | undefined, headers: Record<string, unknown>) => {
    const headerName = (process.env.BITESHIP_WEBHOOK_HEADER || '').trim().toLowerCase();
    const secret = process.env.BITESHIP_WEBHOOK_SECRET || '';
    if (!headerName || !secret) throw new Error('Webhook Biteship belum dikonfigurasi');
    const supplied = String(headers[headerName] ?? '');
    const expected = Buffer.from(secret);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ValidationError('Signature webhook tidak valid');

    const orderId = String(body?.order_id ?? body?.id ?? body?.order?.id ?? '');
    const eventName = String(body?.event ?? body?.event_name ?? 'order.status');
    if (!['order.status', 'order.waybill_id'].includes(eventName)) return { ignored: true };
    if (!orderId) throw new ValidationError('ID order Biteship tidak ditemukan di webhook');
    const eventHash = createHash('sha256').update(rawBody ?? Buffer.from(JSON.stringify(body))).digest('hex');
    const statusRaw = body?.status ?? body?.order?.status;
    const status = normalizeDeliveryStatus(statusRaw);
    const courier = body?.courier ?? body?.order?.courier ?? {};
    const providerUpdatedAt = body?.updated_at ?? body?.timestamp ?? null;
    const client = await pool.connect();
    let changed: { attemptId: number; status: string } | null = null;
    try {
        await client.query('BEGIN');
        const inserted = await client.query(`
            INSERT INTO biteship_webhook_events (event_hash, event_name, biteship_order_id)
            VALUES ($1, $2, $3) ON CONFLICT (event_hash) DO NOTHING RETURNING id
        `, [eventHash, eventName, orderId]);
        if (!inserted.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
        const attempt = await client.query(`
            SELECT a.id, a.order_id, a.status, a.provider_updated_at
            FROM order_delivery_attempts a WHERE a.biteship_order_id = $1 FOR UPDATE
        `, [orderId]);
        if (!attempt.rowCount) { await client.query('COMMIT'); return { unmatched: true }; }
        const current = attempt.rows[0];
        const incomingTime = providerUpdatedAt ? new Date(providerUpdatedAt) : null;
        const isOlder = incomingTime && current.provider_updated_at && incomingTime < new Date(current.provider_updated_at);
        const currentTerminal = FINAL_ATTEMPT_STATUSES.includes(current.status);
        if (!isOlder && status && (!currentTerminal || status === current.status)) {
            await client.query(`
                UPDATE order_delivery_attempts SET status = $2, provider_status = $3,
                    provider_updated_at = COALESCE($4::timestamptz, CURRENT_TIMESTAMP),
                    tracking_link = COALESCE($5, tracking_link), waybill_id = COALESCE($6, waybill_id),
                    driver_name = COALESCE($7, driver_name), driver_phone = COALESCE($8, driver_phone),
                    driver_plate_number = COALESCE($9, driver_plate_number),
                    failure_message = CASE WHEN $2::varchar = 'FAILED' THEN COALESCE(failure_message, 'Biteship gagal mengalokasikan kurir.') ELSE failure_message END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [current.id, status, statusRaw ?? null, providerUpdatedAt,
                body?.courier_link ?? body?.tracking_link ?? body?.link ?? courier?.link ?? null,
                body?.courier_waybill_id ?? body?.waybill_id ?? courier?.waybill_id ?? null,
                body?.courier_driver_name ?? courier?.driver_name ?? courier?.name ?? null,
                body?.courier_driver_phone ?? courier?.driver_phone ?? courier?.phone ?? null,
                body?.courier_driver_plate_number ?? courier?.driver_plate_number ?? null]);
            changed = { attemptId: current.id, status };
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
    } finally {
        client.release();
    }
    // After commit, once per attempt (delivery_notified_at / failure_notified_at), so webhook retries stay quiet.
    if (changed?.status === 'DELIVERED') notifyInBackground(notifyDeliveryDelivered, changed.attemptId);
    if (changed?.status === 'FAILED' || changed?.status === 'CANCELLED') notifyInBackground(notifyDeliveryProblem, changed.attemptId);
    return { ok: true };
};
