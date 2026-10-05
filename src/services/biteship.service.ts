import { pool } from '../config/db';
import { biteshipGet, biteshipPost } from '../utils/biteship';
import { getStoreById } from './store.service';
import { getMenuBoxMap, boxShippingItem } from './menu.service';
import { boxLabel } from '../utils/boxLabel';
import { formatWAPhone } from '../utils/phone';

/** BITESHIP_ENABLED=true: Store Delivery via Biteship is used at all (quotes + courier booking). */
export const isBiteshipEnabled = () => process.env.BITESHIP_ENABLED === 'true';

/** BITESHIP_WHITELIST: comma-separated phone numbers (any format) — empty means every customer. */
const biteshipWhitelist = () =>
    (process.env.BITESHIP_WHITELIST || '').split(',').map(p => formatWAPhone(p.trim())).filter(Boolean);

/** Whether this customer may pick Store Delivery: Biteship on, and their number whitelisted (if a list is set). */
export const isStoreDeliveryAllowed = (phone: string | null | undefined) => {
    if (!isBiteshipEnabled()) return false;
    const whitelist = biteshipWhitelist();
    return whitelist.length === 0 || (!!phone && whitelist.includes(formatWAPhone(phone)));
};

// Couriers asked for rates when the client doesn't specify any (instant + same-day coverage).
export const DEFAULT_RATE_COURIERS = 'gosend,grab,gojek,lalamove,paxel,borzo,sicepat,anteraja,jne,jnt';

/**
 * Store delivery services the customer can choose from. All are booked with delivery_type "now"
 * when the order is DONE (ready), so the driver comes when the order is ready.
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
}): Promise<DeliveryOption[]> => {
    const store = await getStoreById(params.store_id);
    const boxes = await getMenuBoxMap();
    const couriers = offeredCouriers();
    const data: any = await biteshipPost('/rates/couriers', {
        origin_latitude: Number(store.latitude),
        origin_longitude: Number(store.longitude),
        destination_latitude: params.lat,
        destination_longitude: params.lng,
        couriers: couriers.join(','),
        items: params.items.map(item => ({
            name: `${boxLabel(item.box_type)} - ${item.name}`,
            ...boxShippingItem(boxes.get(item.box_type), item.box_type),
            ...(item.unit_price != null ? { value: Number(item.unit_price) } : {}),
            quantity: item.qty,
        })),
    });
    return ((data?.pricing ?? []) as any[])
        // courier_code / courier_service_code are what POST /orders expects as courier_company / courier_type.
        .filter(r => couriers.includes(r.courier_code) && COURIER_SERVICES[r.courier_code] === r.courier_service_code && Number(r.price) > 0)
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

// Placeholder written while a dispatch is in flight, so a concurrent call can't create a second one.
const CLAIM = 'PENDING';

type DispatchResult =
    | { status: 'created'; biteship_order_id: string }
    | { status: 'skipped'; reason: string };

/** Atomically claims the order for dispatch. Returns false if it was already dispatched/claimed. */
const claimDispatch = async (orderId: number) => {
    const { rowCount } = await pool.query(
        'UPDATE orders SET biteship_order_id = $2 WHERE id = $1 AND biteship_order_id IS NULL',
        [orderId, CLAIM]
    );
    return rowCount === 1;
};

const releaseClaim = (orderId: number) =>
    pool.query('UPDATE orders SET biteship_order_id = NULL WHERE id = $1 AND biteship_order_id = $2', [orderId, CLAIM]);

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
export const createBiteshipDispatch = async (order: any): Promise<DispatchResult> => {
    if (order.delivery_method !== 'store_delivery') return { status: 'skipped', reason: 'not store_delivery' };
    if (!isBiteshipEnabled()) {
        console.warn(`[Biteship] BITESHIP_ENABLED is off — courier for Order #${order.id} not booked.`);
        return { status: 'skipped', reason: 'biteship disabled' };
    }
    if (!order.delivery_address || !order.delivery_lat || !order.delivery_lng) {
        console.error(`[Biteship] Order #${order.id} is store_delivery but missing coordinate/address info.`);
        return { status: 'skipped', reason: 'missing address/coordinates' };
    }
    if (!(await claimDispatch(order.id))) return { status: 'skipped', reason: 'already dispatched' };

    try {
        // Optional for instant couriers: they go by destination_coordinate (addresses picked via Google
        // search often have no postal code to resolve an area from).
        const areaId = await resolveAreaId(order);

        const originStore = order.store_id ? await getStoreById(order.store_id) : null;
        if (!originStore) {
            console.error(`[Biteship] Cannot create order #${order.id}: store_id is missing or store not found.`);
            await releaseClaim(order.id);
            return { status: 'skipped', reason: 'no store' };
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
            items: (order.items || []).map((item: any) => ({
                name: `${boxLabel(item.box_type)} - ${item.name}`,
                description: `RPN ${item.box_type}`,
                ...boxShippingItem(boxes.get(item.box_type), item.box_type),
                // Declared value = the box price actually charged.
                ...(item.unit_price != null ? { value: Number(item.unit_price) } : {}),
                quantity: item.qty,
            })),
            order_note: `RPN Order #${order.id}${order.note ? ` - ${order.note}` : ''}`,
        };

        const created: any = await biteshipPost('/orders', payload);
        const biteshipOrderId = String(created?.id ?? created?.order_id ?? 'UNKNOWN');
        await pool.query('UPDATE orders SET biteship_order_id = $2 WHERE id = $1', [order.id, biteshipOrderId]);
        console.log(`[Biteship] Auto-created order ${biteshipOrderId} for RPN #${order.id}`);
        return { status: 'created', biteship_order_id: biteshipOrderId };
    } catch (err) {
        // Nothing was created (or we can't tell) — release so an admin can retry by setting PAID again.
        await releaseClaim(order.id).catch(() => undefined);
        throw err;
    }
};
