import { Router } from 'express';
import { createOrder, getOrders } from '../services/order.service';

const router = Router();

router.post('/order', async (req, res) => {
    try {
        const { customer_name, pesanan, pickup_date, pickup_time, note } = req.body;

        if (!customer_name || !pesanan || !pickup_date) {
            res.status(400).json({ status: 'error', message: 'customer_name, pesanan, dan pickup_date wajib diisi' });
            return;
        }

        const data = await createOrder({ customer_name, pesanan, pickup_date, pickup_time, note });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.get('/orders', async (req, res) => {
    try {
        const { status, day } = req.query;
        const data = await getOrders({
            status: status as string | undefined,
            day: day as string | undefined,
        });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
