import { pool } from '../config/db';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';
import { boxLabel } from '../utils/boxLabel';
import { formatWAPhone } from '../utils/phone';
import {
    createDokuCheckoutPayment,
    getDokuOrderStatus,
    isDokuDevBypass,
    parseDokuExpiredDate,
    verifyDokuNotification,
} from '../utils/doku';
import { changeOrderStatus, getOrderById, getOrderIdByPublicToken } from './order.service';
import { onOrderStatusChanged } from './orderEvents.service';
import { sendPushToAll } from './push.service';
import { startRecurringJob } from '../utils/recurringJob';

// DOKU Checkout flow (DOKU_PAYMENT=true):
//   1. POST /order creates the order (UNPAID, payment_method DOKU), then startDokuCheckout() asks DOKU
//      for a checkout page and the frontend redirects the customer to it.
//   2. DOKU POSTs an HTTP notification on payment → handleDokuNotification() marks the order PAID
//      (same side effects as an admin marking it PAID: WhatsApp + Biteship dispatch).
//   3. When the customer comes back to /status/<token> (callback_url), syncDokuPayment() asks DOKU's Check Status API,
//      in case the notification hasn't arrived (or can't reach us, e.g. local development).

interface CheckoutOrder {
    id: number;
    public_token: string;
    customer_name: string;
    customer_phone: string;
    items: { box_type: string; name: string; qty: number; unit_price: number | null; price_variant_id?: number | null }[];
    /** Store delivery shipping fee, charged on top of the items. */
    delivery_fee?: number | null;
    delivery_courier_company?: string | null;
    delivery_courier_type?: string | null;
}

const frontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:3000';
const paymentDueMinutes = () => Number(process.env.DOKU_PAYMENT_DUE_MINUTES) || 60;
/** Channels offered on the checkout page (DOKU names, comma-separated). Default: QRIS only. */
const paymentMethodTypes = () =>
    (process.env.DOKU_PAYMENT_METHODS || 'QRIS').split(',').map(m => m.trim()).filter(Boolean);

/** Unique per checkout attempt (DOKU rejects reused invoice numbers); letters, digits and '-' only. */
const newInvoiceNumber = (orderId: number) => `RPN-${orderId}-${Date.now().toString(36).toUpperCase()}`;

const itemsAmount = (items: CheckoutOrder['items']) =>
    items.reduce((sum, i) => sum + i.qty * Number(i.unit_price ?? 0), 0);

/** What the customer pays on DOKU: the items plus the store delivery fee, if any. */
const payableAmount = (itemsTotal: number, deliveryFee: number | null | undefined) =>
    Math.round(itemsTotal + Number(deliveryFee ?? 0));

/**
 * Creates the DOKU checkout page for a freshly created order and stores its link on the order.
 * If DOKU refuses, the order is cancelled (releasing its quota and stock) and the error is rethrown,
 * so the customer never ends up with an order they cannot pay.
 */
export const startDokuCheckout = async <T extends CheckoutOrder>(order: T) => {
    try {
        const amount = payableAmount(itemsAmount(order.items), order.delivery_fee);
        const deliveryFee = Math.round(Number(order.delivery_fee ?? 0));
        if (amount <= 0) throw new AppError(400, 'Total pesanan harus lebih dari 0 untuk pembayaran online');

        const invoiceNumber = newInvoiceNumber(order.id);
        const returnUrl = `${frontendUrl()}/status/${order.public_token}`;

        if (isDokuDevBypass()) {
            // No DOKU: the "checkout page" is the order's status page, and the payment succeeds at once.
            await pool.query(
                `UPDATE orders SET doku_invoice_number = $2, doku_payment_url = $3, doku_expired_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [order.id, invoiceNumber, returnUrl]
            );
            const outcome = await applyDokuStatus(invoiceNumber, 'SUCCESS', amount, 'DEV_BYPASS');
            console.warn(`[DOKU] DOKU_DEV_BYPASS: order #${order.id} paid without DOKU (${outcome})`);
            return {
                ...order,
                ...(outcome === 'paid' ? { status: 'PAID' } : {}),
                doku_invoice_number: invoiceNumber,
                doku_payment_url: returnUrl,
                doku_expired_at: null,
                payment_url: returnUrl,
            };
        }

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
                })).concat(deliveryFee > 0 ? [{
                    id: String(order.items.length + 1).padStart(3, '0'),
                    name: `Ongkir (${[order.delivery_courier_company, order.delivery_courier_type].filter(Boolean).join(' ') || 'Store Delivery'})`.slice(0, 255),
                    quantity: 1,
                    price: deliveryFee,
                    sku: 'DELIVERY',
                    category: 'transportation',
                }] : []),
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

/** Push to admins about a payment that needs a human (wrong amount, paid after cancel); never throws. */
const alertAdmins = (orderId: number, title: string, body: string) => {
    sendPushToAll({ title, body, url: `/orders?order=${orderId}`, tag: `doku-${orderId}` })
        .catch(err => console.error(`[DOKU] admin alert for order #${orderId} failed:`, err?.message ?? err));
};

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
        const expected = payableAmount(Number(order.total_amount), order.delivery_fee);

        // Only the first SUCCESS claims the payment; later duplicates fall through (also for the
        // problem cases below, so admins are alerted once per payment).
        const claimed = await pool.query(
            'UPDATE orders SET doku_paid_at = CURRENT_TIMESTAMP, doku_paid_channel = $2 WHERE id = $1 AND doku_paid_at IS NULL',
            [row.id, channel ?? null]
        );
        if (claimed.rowCount === 0) return 'ignored';

        if (amount !== undefined && Math.round(amount) !== expected) {
            // The customer paid, but not the order's current total: leave the status for an admin.
            console.error(`[DOKU] amount mismatch for order #${row.id}: paid ${amount}, expected ${expected}`);
            alertAdmins(row.id, `⚠️ Pembayaran DOKU tidak cocok · Order #${row.id}`,
                `${order.customer_name} membayar Rp ${Math.round(amount).toLocaleString('id-ID')}, total order Rp ${expected.toLocaleString('id-ID')}. Status masih ${order.status} — cek dan sesuaikan manual.`);
            return 'ignored';
        }

        if (order.status !== 'UNPAID') {
            // E.g. the order expired and was cancelled, or an admin already moved it on — leave the
            // status alone, but tell admins (a cancelled order that got paid needs a refund or reopening).
            console.warn(`[DOKU] order #${row.id} paid via DOKU while in status ${order.status}; status left unchanged`);
            alertAdmins(row.id, `💸 Order #${row.id} dibayar via DOKU tapi ${order.status}`,
                `${order.customer_name} membayar Rp ${expected.toLocaleString('id-ID')}. ${order.status === 'CANCELLED' ? 'Order sudah dibatalkan: refund atau aktifkan ulang.' : 'Status dibiarkan, cek order.'}`);
            return 'ignored';
        }

        // expectedStatus: an order cancelled meanwhile (e.g. store closed) keeps its status.
        const changed = await changeOrderStatus(row.id, 'PAID', { expectedStatus: 'UNPAID' }).catch(err => {
            if (err instanceof ConflictError) return null;
            throw err;
        });
        if (!changed) {
            console.warn(`[DOKU] order #${row.id} paid via DOKU but no longer UNPAID; status left unchanged`);
            alertAdmins(row.id, `💸 Order #${row.id} dibayar via DOKU tapi status sudah berubah`,
                `${order.customer_name} membayar Rp ${expected.toLocaleString('id-ID')} saat order diubah/dibatalkan. Cek order: refund atau aktifkan ulang.`);
            return 'ignored';
        }
        const { previousStatus } = changed;
        getOrderById(row.id)
            .then(full => onOrderStatusChanged(full, previousStatus))
            .catch(err => console.error(`[order-events] could not load order #${row.id}:`, err));
        return 'paid';
    }

    if (status === 'EXPIRED' && row.status === 'UNPAID') {
        // Unpaid checkout expired → give the quota slot and raw materials back.
        await changeOrderStatus(row.id, 'CANCELLED', { expectedStatus: 'UNPAID' }).catch(err => {
            if (!(err instanceof ConflictError)) throw err;
        });
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

/** How long after DOKU's expiry an unpaid checkout is closed (late notifications get this long). */
const EXPIRY_GRACE_MINUTES = 5;

/**
 * Closes UNPAID DOKU orders whose checkout expired, so they stop holding quota and raw materials
 * (review 2026-10-19, H3). DOKU is asked first, so a payment that landed without a notification still
 * makes the order PAID; 404 = the customer never picked a payment method → expired. Other DOKU errors
 * leave the order for the next round.
 */
export const expireUnpaidDokuOrders = async () => {
    if (isDokuDevBypass()) return { checked: 0, cancelled: 0, paid: 0 };
    const { rows } = await pool.query(`
        SELECT id, doku_invoice_number FROM orders
        WHERE payment_method = 'DOKU' AND status = 'UNPAID' AND doku_paid_at IS NULL
          AND doku_invoice_number IS NOT NULL AND doku_expired_at IS NOT NULL
          AND doku_expired_at < now() - make_interval(mins => $1)
        ORDER BY id LIMIT 50`, [EXPIRY_GRACE_MINUTES]);
    let cancelled = 0, paid = 0;
    for (const order of rows) {
        let status: string | undefined, amount: number | undefined, channel: string | undefined;
        try {
            const res = await getDokuOrderStatus(order.doku_invoice_number);
            status = res.transaction?.status === 'SUCCESS' ? 'SUCCESS' : 'EXPIRED';
            amount = res.order?.amount;
            channel = res.channel?.id;
        } catch (err) {
            if ((err as { httpStatus?: number }).httpStatus !== 404) {
                console.warn(`[DOKU] expiry check for order #${order.id} failed, retrying next round:`, (err as Error).message);
                continue;
            }
            status = 'EXPIRED';
        }
        const outcome = await applyDokuStatus(order.doku_invoice_number, status, amount, channel);
        if (outcome === 'cancelled') cancelled++;
        if (outcome === 'paid') paid++;
    }
    return { checked: rows.length, cancelled, paid };
};

/** DOKU_EXPIRY_MINUTES (default 5; 0 = off): how often expireUnpaidDokuOrders runs. */
export const startDokuExpiryJob = () =>
    startRecurringJob('[DOKU] expiry check', 'DOKU_EXPIRY_MINUTES', 5, async () => {
        const { checked, cancelled, paid } = await expireUnpaidDokuOrders();
        return cancelled || paid ? `${checked} expired checkout(s): ${cancelled} cancelled, ${paid} paid` : null;
    });

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
    if (isDokuDevBypass()) return;

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
