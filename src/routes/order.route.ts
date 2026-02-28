import { Router } from 'express';
import { createOrder, getOrders, updateOrderStatus, updatePaymentMethod, updateOrder } from '../services/order.service';
import { sendPushToAll } from '../services/push.service';
import { getWhatsAppService } from '../services/whatsapp.service';

const router = Router();

router.post('/order', async (req, res) => {
    try {
        const { customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method } = req.body;

        if (!customer_name || !customer_phone || !pesanan || !pickup_date) {
            res.status(400).json({ status: 'error', message: 'customer_name, customer_phone, pesanan, dan pickup_date wajib diisi' });
            return;
        }

        const data = await createOrder({ customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method });

        // Fire-and-forget push notification
        sendPushToAll({
            title: '🛍️ Order Baru Masuk!',
            body: `${customer_name} — pickup ${pickup_date}${pickup_time ? ' · ' + pickup_time : ''}`,
            url: '/orders',
        }).catch(console.error);

        // Auto-send WhatsApp if connected
        try {
            const waService = getWhatsAppService();
            if (waService.isConnected) {
                const orderDetails = pesanan.map((p: any) => `- ${p.qty}x ${p.box_type === 'FULL' ? 'Full Box' : 'Half Box'} (${p.name})`).join('\n');
                const totalBox = pesanan.reduce((sum: number, p: any) => sum + p.qty, 0);

                // Currently backend doesn't fetch menus directly here to calculate totalAmount easily.
                // It's better to fetch it or rely on the frontend payload. But the user didn't mention sending amount from frontend.
                // Wait, creating the order doesn't calculate amount either. Let's just use the template provided by the user.

                const uploadLink = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/pesan`;
                // The provided template from user:
                // "Hai {{customer_name}}, pesanannya sudah diterima ya.\n\nDetail Pesanan:\n{{order_details}}\n\nJumlah: {{total_box}} box\nTotal: Rp {{total_amount}}\n\nPembayaran bisa melalui:\nBank: BCA\nNo Rek: 123456789\nA/N: Anggita Prima\n\nMohon konfirmasi bukti pembayarannya melalui link berikut:\n{{upload_link}}\n\nTerima kasih,\nAnggita"

                // Since we need total_amount, we need to quickly query the menus
                const { rows: menuRows } = await import('../config/db').then(m => m.pool.query('SELECT name, price FROM menu'));
                const menuMap = new Map<string, number>(menuRows.map((r: any) => [r.name, Number(r.price)]));

                const totalAmount = pesanan.reduce((sum: number, p: any) => sum + (p.qty * (menuMap.get(p.box_type) || 0)), 0);

                let waMessage = "Hai {{customer_name}}, pesanannya sudah diterima ya.\n\nDetail Pesanan:\n{{order_details}}\n\nJumlah: {{total_box}} box\nTotal: Rp {{total_amount}}\n\nPembayaran bisa melalui:\nBank: BCA\nNo Rek: 123456789\nA/N: Anggita Prima\n\nMohon konfirmasi bukti pembayarannya melalui link berikut:\n{{upload_link}}\n\nTerima kasih,\nAnggita";

                waMessage = waMessage.replace('{{customer_name}}', customer_name);
                waMessage = waMessage.replace('{{order_details}}', orderDetails);
                waMessage = waMessage.replace('{{total_box}}', String(totalBox));
                waMessage = waMessage.replace('{{total_amount}}', totalAmount.toLocaleString('id-ID'));
                waMessage = waMessage.replace('{{upload_link}}', uploadLink);

                // Re-format phone (just in case frontend didn't do it)
                let waPhone = customer_phone.replace(/[^0-9]/g, '');
                if (waPhone.startsWith('0')) waPhone = '62' + waPhone.substring(1);

                waService.sendMessage(waPhone, waMessage).catch(err => {
                    console.error('Auto WA Send Error:', err);
                });
            }
        } catch (waErr) {
            console.error('Failed to prepare auto WA message:', waErr);
        }

        res.json({ status: 'ok', data });
    } catch (e: any) {
        console.error('Error creating order:', e);
        res.status(500).json({ status: 'error', message: e?.message || String(e), detail: e });
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

        const data = await updateOrderStatus(id, status);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(400).json({ status: 'error', message: e.message });
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
        res.status(400).json({ status: 'error', message: e.message });
    }
});

export default router;

