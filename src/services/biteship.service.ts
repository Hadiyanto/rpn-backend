import { pool } from '../config/db';
import { biteshipGet, biteshipPost } from '../utils/biteship';
import { getStoreById } from './store.service';
import { getMenuBoxMap, boxShippingItem } from './menu.service';
import { todayWIB } from '../utils/date';
import { boxLabel } from '../utils/boxLabel';

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
 * Creates the Grab instant shipment for a PAID store-delivery order, at most once per order.
 * `order` is the full order as returned by getOrderById (with items).
 */
export const createBiteshipDispatch = async (order: any): Promise<DispatchResult> => {
    if (order.delivery_method !== 'store_delivery') return { status: 'skipped', reason: 'not store_delivery' };
    if (!order.delivery_address || !order.delivery_lat || !order.delivery_lng) {
        console.error(`[Biteship] Order #${order.id} is store_delivery but missing coordinate/address info.`);
        return { status: 'skipped', reason: 'missing address/coordinates' };
    }
    if (!(await claimDispatch(order.id))) return { status: 'skipped', reason: 'already dispatched' };

    try {
        const areaId = await resolveAreaId(order);
        if (!areaId) {
            console.error(`[Biteship] Cannot create order #${order.id}: delivery_area_id is missing and could not be resolved.`);
            await releaseClaim(order.id);
            return { status: 'skipped', reason: 'no area id' };
        }

        const originStore = order.store_id ? await getStoreById(order.store_id) : null;
        if (!originStore) {
            console.error(`[Biteship] Cannot create order #${order.id}: store_id is missing or store not found.`);
            await releaseClaim(order.id);
            return { status: 'skipped', reason: 'no store' };
        }

        // "Today" is a WIB calendar day. The server runs in UTC, so its local date is
        // still yesterday between 00:00 and 07:00 WIB.
        const isToday = order.pickup_date === todayWIB();
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
            destination_area_id: areaId,
            destination_coordinate: { latitude: Number(order.delivery_lat), longitude: Number(order.delivery_lng) },
            ...(order.delivery_driver_note ? { destination_note: order.delivery_driver_note } : {}),
            // Courier defaults to grab instant
            courier_company: 'grab',
            courier_type: 'instant',
            // Delivery Schedule Logic
            delivery_type: isToday ? 'now' : 'scheduled',
            ...(isToday ? {} : {
                delivery_date: order.pickup_date,
                delivery_time: order.pickup_time ? order.pickup_time.split(' ')[0] : '11:00', // Extracts HH:mm
            }),
            items: (order.items || []).map((item: any) => ({
                name: `${boxLabel(item.box_type)} - ${item.name}`,
                description: `RPN ${item.box_type}`,
                ...boxShippingItem(boxes.get(item.box_type), item.box_type),
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
