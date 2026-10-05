import { pool } from '../config/db';
import { AppError, NotFoundError } from '../utils/errors';
import { boxLabel } from '../utils/boxLabel';
import { formatWAPhone } from '../utils/phone';
import {
    createDokuCheckoutPayment,
    getDokuOrderStatus,
    parseDokuExpiredDate,
    verifyDokuNotification,
} from '../utils/doku';
import { changeOrderStatus, getOrderById, getOrderIdByPublicToken } from './order.service';
import { onOrderStatusChanged } from './orderEvents.service';

// DOKU Checkout flow (DOKU_PAYMENT=true):
//   1. POST /order creates the order (UNPAID, payment_method DOKU), then startDokuCheckout() asks DOKU
//      for a checkout page and the frontend redirects the customer to it.
//   2. DOKU POSTs an HTTP notification on payment → handleDokuNotification() marks the order PAID
//      (same side effects as an admin marking it PAID: WhatsApp + Biteship dispatch).
//   3. When the customer comes back (callback_url), syncDokuPayment() asks DOKU's Check Status API,
//      in case the notification hasn't arrived (or can't reach us, e.g. local development).

interface CheckoutOrder {
    id: number;
    public_token: string;
    customer_name: string;
    customer_phone: string;
    items: { box_type: string; name: string; qty: number; unit_price: number | null; price_variant_id?: number | null }[];
}

const frontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:3000';
const paymentDueMinutes = () => Number(process.env.DOKU_PAYMENT_DUE_MINUTES) || 60;
/** Channels offered on the checkout page (DOKU names, comma-separated). Default: QRIS only. */
const paymentMethodTypes = () =>
    (process.env.DOKU_PAYMENT_METHODS || 'QRIS').split(',').map(m => m.trim()).filter(Boolean);

/** Unique per checkout attempt (DOKU rejects reused invoice numbers); letters, digits and '-' only. */
const newInvoiceNumber = (orderId: number) => `RPN-${orderId}-${Date.now().toString(36).toUpperCase()}`;

const orderAmount = (items: CheckoutOrder['items']) =>
    items.reduce((sum, i) => sum + i.qty * Number(i.unit_price ?? 0), 0);

/**
 * Creates the DOKU checkout page for a freshly created order and stores its link on the order.
 * If DOKU refuses, the order is cancelled (releasing its quota and stock) and the error is rethrown,
 * so the customer never ends up with an order they cannot pay.
 */
export const startDokuCheckout = async <T extends CheckoutOrder>(order: T) => {
    try {
        const amount = orderAmount(order.items);
        if (amount <= 0) throw new AppError(400, 'Total pesanan harus lebih dari 0 untuk pembayaran online');

        const invoiceNumber = newInvoiceNumber(order.id);
        const returnUrl = `${frontendUrl()}/bukti-transfer/${order.public_token}`;
        const { response } = await createDokuCheckoutPayment({
            order: {
                amount,
                invoice_number: invoiceNumber,
                currency: 'IDR',
                callback_url: returnUrl,
                callback_url_result: returnUrl,
                auto_redirect: true,
                // DOKU checks that line items add up to the amount.
                line_items: order.items.map((i, idx) => ({
                    id: String(idx + 1).padStart(3, '0'),
                    name: `${boxLabel(i.box_type)} - ${i.name}`.slice(0, 255),
                    quantity: i.qty,
                    price: Number(i.unit_price ?? 0),
                    // Box type + the flavor that set the price, e.g. FULL-6.
                    sku: `${i.box_type}${i.price_variant_id ? `-${i.price_variant_id}` : ''}`,
                    category: 'food-and-beverage',
                })),
            },
            payment: {
                payment_due_date: paymentDueMinutes(),
                type: 'SALE',
                payment_method_types: paymentMethodTypes(),
            },
            customer: {
                name: order.customer_name.slice(0, 255),
                phone: formatWAPhone(order.customer_phone).slice(0, 16),
            },
            ...(process.env.DOKU_NOTIFICATION_URL
                ? { additional_info: { override_notification_url: process.env.DOKU_NOTIFICATION_URL } }
                : {}),
        });

        const expiredAt = parseDokuExpiredDate(response.payment.expired_date);
        await pool.query(
            `UPDATE orders SET doku_invoice_number = $2, doku_payment_url = $3, doku_expired_at = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [order.id, invoiceNumber, response.payment.url, expiredAt]
        );

        return {
            ...order,
            doku_invoice_number: invoiceNumber,
            doku_payment_url: response.payment.url,
            doku_expired_at: expiredAt,
            payment_url: response.payment.url,
        };
    } catch (e) {
        await changeOrderStatus(order.id, 'CANCELLED').catch(err =>
            console.error(`[DOKU] could not cancel order #${order.id} after checkout failure:`, err));
        throw e;
    }
};

type DokuOutcome = 'paid' | 'cancelled' | 'ignored';

/**
 * Applies a DOKU transaction status to the order behind `invoiceNumber`. Idempotent: duplicate
 * notifications (DOKU retries, notification + check status) only take effect once.
 */
const applyDokuStatus = async (
    invoiceNumber: string,
    status: string | undefined,
    amount: number | undefined,
    channel: string | undefined,
): Promise<DokuOutcome> => {
    const { rows: [row] } = await pool.query(
        'SELECT id, status FROM orders WHERE doku_invoice_number = $1',
        [invoiceNumber]
    );
    if (!row) {
        console.warn(`[DOKU] notification for unknown invoice ${invoiceNumber}`);
        return 'ignored';
    }

    if (status === 'SUCCESS') {
        const order = await getOrderById(row.id);
        if (amount !== undefined && Math.round(amount) !== Math.round(Number(order.total_amount))) {
            console.error(`[DOKU] amount mismatch for order #${row.id}: paid ${amount}, order total ${order.total_amount}`);
            return 'ignored';
        }

        // Only the first SUCCESS claims the payment; later duplicates fall through.
        const claimed = await pool.query(
            'UPDATE orders SET doku_paid_at = CURRENT_TIMESTAMP, doku_paid_channel = $2 WHERE id = $1 AND doku_paid_at IS NULL',
            [row.id, channel ?? null]
        );
        if (claimed.rowCount === 0) return 'ignored';

        if (order.status !== 'UNPAID') {
            // E.g. the order expired and was cancelled, or an admin already moved it on — leave the
            // status alone, admins see doku_paid_at on the order.
            console.warn(`[DOKU] order #${row.id} paid via DOKU while in status ${order.status}; status left unchanged`);
            return 'ignored';
        }

        const { previousStatus } = await changeOrderStatus(row.id, 'PAID');
        getOrderById(row.id)
            .then(full => onOrderStatusChanged(full, previousStatus))
            .catch(err => console.error(`[order-events] could not load order #${row.id}:`, err));
        return 'paid';
    }

    if (status === 'EXPIRED' && row.status === 'UNPAID') {
        // Unpaid checkout expired → give the quota slot and raw materials back.
        await changeOrderStatus(row.id, 'CANCELLED');
        return 'cancelled';
    }

    // FAILED is ignored on purpose: on the checkout page the customer can retry with another method.
    return 'ignored';
};

/** Handles DOKU's HTTP notification. `target` is the path DOKU posted to (part of the signature). */
export const handleDokuNotification = async (
    headers: Record<string, string | string[] | undefined>,
    target: string,
    rawBody: Buffer | undefined,
) => {
    if (!rawBody || !verifyDokuNotification(headers, target, rawBody)) {
        throw new AppError(401, 'Signature tidak valid');
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    const invoiceNumber: string | undefined = body?.order?.invoice_number;
    if (!invoiceNumber) return 'ignored' as DokuOutcome;

    const status: string | undefined = body?.transaction?.status ?? (body?.order?.status === 'ORDER_EXPIRED' ? 'EXPIRED' : undefined);
    const amount = body?.order?.amount === undefined ? undefined : Number(body.order.amount);
    return applyDokuStatus(invoiceNumber, status, amount, body?.channel?.id);
};

/**
 * Asks DOKU for the current status of an UNPAID DOKU order (customer is back from the checkout page)
 * and applies it. Never throws on DOKU errors — the order simply stays as it is.
 */
export const syncDokuPayment = async (token: string) => {
    const id = await getOrderIdByPublicToken(token);
    const { rows: [order] } = await pool.query(
        'SELECT status, payment_method, doku_invoice_number FROM orders WHERE id = $1',
        [id]
    );
    if (!order) throw new NotFoundError('Order tidak ditemukan');
    if (order.payment_method !== 'DOKU' || order.status !== 'UNPAID' || !order.doku_invoice_number) return;

    try {
        const res = await getDokuOrderStatus(order.doku_invoice_number);
        const status = res.transaction?.status === 'SUCCESS'
            ? 'SUCCESS'
            : res.order?.status === 'ORDER_EXPIRED' ? 'EXPIRED' : res.transaction?.status;
        await applyDokuStatus(order.doku_invoice_number, status, res.order?.amount, res.channel?.id);
    } catch (e) {
        // 404 before the customer picked a channel, network errors, … — not the customer's problem.
        console.warn(`[DOKU] status check for order #${id} failed:`, (e as Error).message);
    }
};
