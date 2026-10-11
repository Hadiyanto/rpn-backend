import { sendPushToAll } from './push.service';
import { getWhatsAppService } from './whatsapp.service';
import { getMenuPriceMap } from './menu.service';
import { createBiteshipDispatch } from './biteship.service';
import { getStoreById, storeMapsUrl } from './store.service';
import { formatWAPhone } from '../utils/phone';
import { formatDateID } from '../utils/date';
import { boxLabel } from '../utils/boxLabel';
import {
    buildNewOrderMessage,
    buildPaidOrderMessage,
    buildDoneOrderMessage,
    buildDeliveryDispatchedMessage,
    courierLabel,
    type DeliveryInfo,
    type StoreInfo,
    brandName,
    buildTransferReceivedMessage,
} from '../utils/waMessages';

// Side effects of order changes (push, WhatsApp, Biteship). Every handler swallows and logs its
// own errors: they run after the order change is committed and must never affect its response.

interface OrderItemLike {
    box_type: string;
    name: string;
    qty: number;
    unit_price?: number | null;
}

const sendWA = async (phone: string | null | undefined, message: string, label: string) => {
    if (!phone) return;
    const wa = getWhatsAppService();
    if (!wa.isConnected) return;
    await wa.sendMessage(formatWAPhone(phone), message).catch(err => console.error(`Auto WA Send Error on ${label}:`, err));
};

/** Courier + address for store-delivery orders; null for pickup. */
const deliveryInfo = (order: {
    delivery_method?: string | null; delivery_address?: string | null;
    delivery_courier_company?: string | null; delivery_courier_type?: string | null;
}): DeliveryInfo | null => order.delivery_method === 'store_delivery'
    ? { courier: courierLabel(order.delivery_courier_company, order.delivery_courier_type), address: order.delivery_address ?? '-' }
    : null;

const schedule = (order: { pickup_date: string; pickup_time?: string | null }) =>
    `${formatDateID(order.pickup_date)}${order.pickup_time ? ' jam ' + order.pickup_time : ''}`;

/** The order's store for messages; falls back to the brand name if it can't be loaded. */
const storeInfo = async (storeId: number | null | undefined): Promise<StoreInfo> => {
    const store = storeId ? await getStoreById(storeId).catch(() => null) : null;
    if (!store) return { name: brandName(), address: null, maps_url: null, bank: null, has_qris: false };
    return {
        name: store.name,
        address: store.address ?? null,
        maps_url: storeMapsUrl(store),
        bank: store.bank_account_number
            ? { name: store.bank_name ?? null, number: store.bank_account_number, holder: store.bank_account_name ?? null }
            : null,
        has_qris: !!store.qris_image_url,
    };
};

/** Customer-facing status page of an order (payment status, transfer proof upload). */
const statusLink = (token: string | undefined) =>
    `${process.env.FRONTEND_URL || 'http://localhost:3000'}/status/${token ?? ''}`;

const guard = (label: string, fn: () => Promise<unknown>) =>
    fn().catch(err => console.error(`[order-events] ${label} failed:`, err));

export const onOrderCreated = (order: { id: number; public_token?: string; customer_name: string; customer_phone: string; pickup_date: string; pickup_time?: string | null; items: OrderItemLike[]; doku_payment_url?: string | null; delivery_fee?: number | null;
    store_id?: number | null; payment_method?: string | null;
    delivery_method?: string | null; delivery_address?: string | null; delivery_courier_company?: string | null; delivery_courier_type?: string | null }) =>
    guard(`created #${order.id}`, async () => {
        sendPushToAll({
            title: '🛍️ Order Baru Masuk!',
            body: `${order.customer_name} — pickup ${formatDateID(order.pickup_date)}${order.pickup_time ? ' · ' + order.pickup_time : ''}`,
            url: '/orders',
        }).catch(console.error);

        const prices = await getMenuPriceMap();
        const boxPrice = (p: OrderItemLike) => (p.unit_price ?? null) !== null ? Number(p.unit_price) : prices.get(p.box_type) || 0;
        await sendWA(order.customer_phone, buildNewOrderMessage({
            customer_name: order.customer_name,
            order_id: order.id,
            order_details: order.items.map(p => `- ${p.qty}x ${boxLabel(p.box_type)} (${p.name})`).join('\n')
                + (order.delivery_fee ? `\n- Ongkir Rp ${Number(order.delivery_fee).toLocaleString('id-ID')}` : ''),
            total_box: order.items.reduce((sum, p) => sum + p.qty, 0),
            total_amount: (order.items.reduce((sum, p) => sum + p.qty * boxPrice(p), 0) + Number(order.delivery_fee ?? 0)).toLocaleString('id-ID'),
            // Link by public_token (not the sequential id) so other customers' orders can't be guessed.
            status_link: statusLink(order.public_token),
            payment_method: order.payment_method,
            store: await storeInfo(order.store_id),
            payment_link: order.doku_payment_url,
            delivery: (() => { const d = deliveryInfo(order); return d ? { ...d, schedule: schedule(order) } : null; })(),
        }), 'NEW');
    });

/** Runs only when the status actually changed (previousStatus !== order.status). */
export const onOrderStatusChanged = (order: any, previousStatus: string) =>
    guard(`status #${order.id} ${previousStatus}→${order.status}`, async () => {
        if (order.status === previousStatus) return;

        const delivery = deliveryInfo(order);

        if (order.status === 'PAID') {
            await sendWA(order.customer_phone, buildPaidOrderMessage({
                customer_name: order.customer_name,
                order_id: order.id,
                scheduleDate: schedule(order),
                store: await storeInfo(order.store_id),
                delivery,
            }), 'PAID');
        }

        if (order.status === 'DONE' && !delivery) {
            await sendWA(order.customer_phone, buildDoneOrderMessage({
                customer_name: order.customer_name,
                order_id: order.id,
                store: await storeInfo(order.store_id),
            }), 'DONE');
        }

        if (order.status === 'DONE' && delivery) {
            // Store delivery: the order is ready → book the courier now (idempotent per order), then
            // tell the customer, with Biteship's tracking link when the booking just went through.
            const dispatch = await createBiteshipDispatch(order).catch(err => {
                console.error(`[Biteship] Failed to auto-create dispatch for Order #${order.id}:`, err?.message ?? err);
                return null;
            });
            await sendWA(order.customer_phone, buildDeliveryDispatchedMessage({
                customer_name: order.customer_name,
                order_id: order.id,
                courier: delivery.courier,
                tracking_link: dispatch?.status === 'created' ? dispatch.tracking_link : null,
            }), 'DONE delivery');
        }
    });

export const onTransferUploaded = (order: { id: number; customer_name: string; customer_phone: string | null }) =>
    guard(`transfer #${order.id}`, () => sendWA(order.customer_phone, buildTransferReceivedMessage(order.customer_name), 'Transfer Img Upload'));
