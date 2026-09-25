import { sendPushToAll } from './push.service';
import { getWhatsAppService } from './whatsapp.service';
import { getMenuPriceMap } from './menu.service';
import { createBiteshipDispatch } from './biteship.service';
import { formatWAPhone } from '../utils/phone';
import { formatDateID } from '../utils/date';
import { boxLabel } from '../utils/boxLabel';
import {
    buildNewOrderMessage,
    buildPaidOrderMessage,
    buildDoneOrderMessage,
    buildTransferReceivedMessage,
} from '../utils/waMessages';

// Side effects of order changes (push, WhatsApp, Biteship). Every handler swallows and logs its
// own errors: they run after the order change is committed and must never affect its response.

interface OrderItemLike {
    box_type: string;
    name: string;
    qty: number;
}

const sendWA = async (phone: string | null | undefined, message: string, label: string) => {
    if (!phone) return;
    const wa = getWhatsAppService();
    if (!wa.isConnected) return;
    await wa.sendMessage(formatWAPhone(phone), message).catch(err => console.error(`Auto WA Send Error on ${label}:`, err));
};

const guard = (label: string, fn: () => Promise<unknown>) =>
    fn().catch(err => console.error(`[order-events] ${label} failed:`, err));

export const onOrderCreated = (order: { id: number; public_token?: string; customer_name: string; customer_phone: string; pickup_date: string; pickup_time?: string | null; items: OrderItemLike[] }) =>
    guard(`created #${order.id}`, async () => {
        sendPushToAll({
            title: '🛍️ Order Baru Masuk!',
            body: `${order.customer_name} — pickup ${formatDateID(order.pickup_date)}${order.pickup_time ? ' · ' + order.pickup_time : ''}`,
            url: '/orders',
        }).catch(console.error);

        const prices = await getMenuPriceMap();
        await sendWA(order.customer_phone, buildNewOrderMessage({
            customer_name: order.customer_name,
            order_id: order.id,
            order_details: order.items.map(p => `- ${p.qty}x ${boxLabel(p.box_type)} (${p.name})`).join('\n'),
            total_box: order.items.reduce((sum, p) => sum + p.qty, 0),
            total_amount: order.items.reduce((sum, p) => sum + p.qty * (prices.get(p.box_type) || 0), 0).toLocaleString('id-ID'),
            // Link by public_token (not the sequential id) so other customers' orders can't be guessed.
            upload_link: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/bukti-transfer/${order.public_token ?? order.id}`,
        }), 'NEW');
    });

/** Runs only when the status actually changed (previousStatus !== order.status). */
export const onOrderStatusChanged = (order: any, previousStatus: string) =>
    guard(`status #${order.id} ${previousStatus}→${order.status}`, async () => {
        if (order.status === previousStatus) return;

        if (order.status === 'PAID') {
            const scheduleDate = `${formatDateID(order.pickup_date)}${order.pickup_time ? ' jam ' + order.pickup_time : ''}`;
            await sendWA(order.customer_phone, buildPaidOrderMessage({
                customer_name: order.customer_name,
                order_id: order.id,
                scheduleDate,
            }), 'PAID');

            await createBiteshipDispatch(order).catch(err =>
                console.error(`[Biteship] Failed to auto-create dispatch for Order #${order.id}:`, err?.message ?? err));
        }

        if (order.status === 'DONE') {
            await sendWA(order.customer_phone, buildDoneOrderMessage({
                customer_name: order.customer_name,
                order_id: order.id,
            }), 'DONE');
        }
    });

export const onTransferUploaded = (order: { id: number; customer_name: string; customer_phone: string | null }) =>
    guard(`transfer #${order.id}`, () => sendWA(order.customer_phone, buildTransferReceivedMessage(order.customer_name), 'Transfer Img Upload'));
