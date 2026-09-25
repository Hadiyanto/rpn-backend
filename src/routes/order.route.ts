import { Router } from 'express';
import { sendError } from '../utils/errors';
import rateLimit from 'express-rate-limit';
import { createOrder, getOrders, getOrderById, changeOrderStatus, updatePaymentMethod, updateOrder, updateTransferImgUrl, getPublicOrder, getOrderIdByPublicToken, assertTransferImgUrl } from '../services/order.service';
import { onOrderCreated, onOrderStatusChanged, onTransferUploaded } from '../services/orderEvents.service';
import { recalculateOrderStock } from '../services/stockDeduction.service';

const router = Router();

// Rate limiter specifically for creating guest orders (anti-spam / quota lock)
const orderLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 order creation requests per windowMs
    message: {
        status: 'error',
        message: 'Anda sudah membuat terlalu banyak pesanan hari ini. Silakan coba lagi nanti.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/order', orderLimiter, async (req, res) => {
    try {
        const {
            customer_name, customer_phone, pesanan, pickup_date, pickup_time,
            note, payment_method, store_id,
            delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
        } = req.body;

        if (!customer_name || !customer_phone || !pesanan || !pickup_date || !store_id) {
            res.status(400).json({ status: 'error', message: 'customer_name, customer_phone, pesanan, pickup_date, dan store_id wajib diisi' });
            return;
        }

        const data = await createOrder({
            customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method, store_id,
            delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
        });

        // Push + WhatsApp run in the background; they never affect the response.
        void onOrderCreated(data);

        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e, 'creating order');
    }
});

router.patch('/order/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const { customer_name, pesanan, pickup_date, pickup_time, note, payment_method, transfer_img_url } = req.body;
        const data = await updateOrder(id, { customer_name, pesanan, pickup_date, pickup_time, note, payment_method, transfer_img_url });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.get('/orders', async (req, res) => {
    try {
        const { status, day, store_id } = req.query;
        const data = await getOrders({
            status: status as string | undefined,
            day: day as string | undefined,
            store_id: store_id ? Number(store_id) : undefined,
        });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// --- Customer-facing endpoints, addressed by the unguessable public_token -----------------

router.get('/order/public/:token', async (req, res) => {
    try {
        const data = await getPublicOrder(req.params.token);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.patch('/order/public/:token/transfer-img-url', async (req, res) => {
    try {
        const id = await getOrderIdByPublicToken(req.params.token);
        const data = await updateTransferImgUrl(id, assertTransferImgUrl(req.body.transfer_img_url));
        if (data) void onTransferUploaded(data);
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.get('/order/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const data = await getOrderById(id);
        if (!data) {
            res.status(404).json({ status: 'error', message: 'Order tidak ditemukan' });
            return;
        }

        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.patch('/order/:id/status', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const { status } = req.body;
        if (!status) {
            res.status(400).json({ status: 'error', message: 'field status wajib diisi' });
            return;
        }

        const { order: data, previousStatus } = await changeOrderStatus(id, status);

        // WhatsApp (PAID/DONE) and the Biteship dispatch (PAID) only on a real status change,
        // in the background. Dispatch is idempotent per order (orders.biteship_order_id).
        getOrderById(id)
            .then(fullOrder => onOrderStatusChanged(fullOrder, previousStatus))
            .catch(err => console.error(`[order-events] could not load order #${id}:`, err));

        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// Recompute an order's stock deduction from its current items and recipes (e.g. after a recipe
// was fixed, or if the automatic deduction failed). Safe to call repeatedly.
router.post('/order/:id/recalculate-stock', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const data = await recalculateOrderStock(id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.patch('/order/:id/payment-method', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const { payment_method } = req.body;
        const data = await updatePaymentMethod(id, payment_method ?? null);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.patch('/order/:id/transfer-img-url', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const data = await updateTransferImgUrl(id, assertTransferImgUrl(req.body.transfer_img_url));

        if (data) void onTransferUploaded(data);

        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
