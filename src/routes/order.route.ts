import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createOrder, getOrders, getOrderById, updateOrderStatus, updatePaymentMethod, updateOrder, updateTransferImgUrl } from '../services/order.service';
import { sendPushToAll } from '../services/push.service';
import { getWhatsAppService } from '../services/whatsapp.service';
import { formatWAPhone } from '../utils/phone';
import { buildNewOrderMessage, buildPaidOrderMessage, buildDoneOrderMessage, buildTransferReceivedMessage } from '../utils/waMessages';
import { pool } from '../config/db';
import { biteshipPost } from '../utils/biteship';

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
            note, payment_method,
            delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
        } = req.body;

        if (!customer_name || !customer_phone || !pesanan || !pickup_date) {
            res.status(400).json({ status: 'error', message: 'customer_name, customer_phone, pesanan, dan pickup_date wajib diisi' });
            return;
        }

        const data = await createOrder({
            customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method,
            delivery_method, delivery_lat, delivery_lng, delivery_address, delivery_driver_note, delivery_area_id
        });

        // Fire-and-forget push notification
        let scheduleDateStr = pickup_date;
        try {
            const dateObj = new Date(`${pickup_date}T00:00:00+07:00`);
            scheduleDateStr = dateObj.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
        } catch (_) { /* fallback to raw string */ }

        sendPushToAll({
            title: '🛍️ Order Baru Masuk!',
            body: `${customer_name} — pickup ${scheduleDateStr}${pickup_time ? ' · ' + pickup_time : ''}`,
            url: '/orders',
        }).catch(console.error);

        // Auto-send WhatsApp if connected
        try {
            const waService = getWhatsAppService();
            if (waService.isConnected) {
                const orderDetails = pesanan.map((p: any) => `- ${p.qty}x ${p.box_type === 'FULL' ? 'Full Box' : p.box_type === 'HALF' ? 'Half Box' : 'Hampers'} (${p.name})`).join('\n');
                const totalBox = pesanan.reduce((sum: number, p: any) => sum + p.qty, 0);
                const uploadLink = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/bukti-transfer/${data.id}`;

                const { rows: menuRows } = await pool.query('SELECT name, price FROM menu');
                const menuMap = new Map<string, number>(menuRows.map((r: any) => [r.name, Number(r.price)]));
                const totalAmount = pesanan.reduce((sum: number, p: any) => sum + (p.qty * (menuMap.get(p.box_type) || 0)), 0);

                const waMessage = buildNewOrderMessage({
                    customer_name,
                    order_id: data.id,
                    order_details: orderDetails,
                    total_box: totalBox,
                    total_amount: totalAmount.toLocaleString('id-ID'),
                    upload_link: uploadLink,
                });

                waService.sendMessage(formatWAPhone(customer_phone), waMessage).catch(err => {
                    console.error('Auto WA Send Error:', err);
                });
            }
        } catch (waErr) {
            console.error('Failed to prepare auto WA message:', waErr);
        }

        res.json({ status: 'ok', data });
    } catch (e: any) {
        console.error('Error creating order:', e);
        res.status(500).json({ status: 'error', message: e?.message || String(e) });
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

        // Auto-send WhatsApp if status becomes PAID
        if (status.toUpperCase() === 'PAID') {
            try {
                const waService = getWhatsAppService();
                if (waService.isConnected) {
                    // FIX: Use getOrderById instead of loading all orders
                    const targetOrder = await getOrderById(id);

                    if (targetOrder && targetOrder.customer_phone) {
                        const [year, month, day] = targetOrder.pickup_date.split('-');
                        const dateObj = new Date(Number(year), Number(month) - 1, Number(day));
                        // Force formatting in id-ID locale without timezone shifting
                        const scheduleDateStr = dateObj.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
                        const scheduleDate = `${scheduleDateStr}${targetOrder.pickup_time ? ' jam ' + targetOrder.pickup_time : ''}`;

                        const waMessage = buildPaidOrderMessage({
                            customer_name: targetOrder.customer_name,
                            order_id: targetOrder.id,
                            scheduleDate,
                        });

                        waService.sendMessage(formatWAPhone(targetOrder.customer_phone), waMessage).catch(err => {
                            console.error('Auto WA Send Error on PAID:', err);
                        });
                    }
                }
            } catch (waErr) {
                console.error('Failed to prepare auto WA message on PAID:', waErr);
            }

            // --- Auto Create Biteship Order ---
            try {
                const targetOrder = await getOrderById(id);
                if (targetOrder && targetOrder.delivery_method === 'store_delivery') {
                    if (targetOrder.delivery_address && targetOrder.delivery_lat && targetOrder.delivery_lng) {

                        let areaId = targetOrder.delivery_area_id;

                        // Fallback: If area_id is missing, try to resolve it from the postal code in the address
                        if (!areaId) {
                            try {
                                const postalMatch = targetOrder.delivery_address.match(/\b\d{5}\b/);
                                if (postalMatch) {
                                    const { biteshipGet } = await import('../utils/biteship');
                                    const areaData: any = await biteshipGet(`/maps/areas?countries=ID&input=${postalMatch[0]}&type=single`);
                                    if (areaData?.areas?.length > 0) {
                                        areaId = areaData.areas[0].id;
                                        console.log(`[Biteship] Auto-resolved area_id ${areaId} for Order #${targetOrder.id}`);
                                    }
                                }
                            } catch (e) {
                                console.error(`[Biteship] Failed to auto-resolve area_id for Order #${targetOrder.id}`, e);
                            }
                        }

                        if (!areaId) {
                            console.error(`[Biteship] Cannot create order #${targetOrder.id}: delivery_area_id is missing and could not be resolved.`);
                            return res.json({ status: 'ok', data }); // Still return OK for the status update itself
                        }

                        // Parse pickup_date reliably without timezone shifts
                        const [year, month, day] = targetOrder.pickup_date.split('-');
                        const orderDateObj = new Date(Number(year), Number(month) - 1, Number(day));

                        const now = new Date();
                        const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());

                        const isToday = orderDateObj.getTime() === todayLocal.getTime();

                        // Map items to Biteship format
                        const biteshipItems = (targetOrder.items || []).map((item: any) => ({
                            name: `${item.box_type === 'FULL' ? 'Full Box' : item.box_type === 'HALF' ? 'Half Box' : 'Hampers'} - ${item.name}`,
                            description: `RPN ${item.box_type}`,
                            value: 50000,
                            length: item.box_type === 'FULL' ? 20 : 10,
                            width: item.box_type === 'FULL' ? 20 : 10,
                            height: 10,
                            weight: item.box_type === 'FULL' ? 1000 : 500,
                            quantity: item.qty
                        }));

                        const payload: Record<string, any> = {
                            // Shipper = RPN toko
                            shipper_contact_name: 'RPN Store',
                            shipper_contact_phone: '081314220599',
                            // Origin = toko
                            origin_contact_name: 'RPN Store',
                            origin_contact_phone: '081314220599',
                            origin_address: 'Belakang TK Widiastuti, Jalan Rawa Jati Timur VIII, RW 08, Rawajati, Pancoran, Jakarta Selatan, DKI Jakarta 12750',
                            origin_area_id: 'IDNP6IDNC148IDND841IDZ12750',
                            origin_coordinate: { latitude: -6.261204, longitude: 106.854106 },
                            // Destination
                            destination_contact_name: targetOrder.customer_name,
                            destination_contact_phone: targetOrder.customer_phone,
                            destination_address: targetOrder.delivery_address,
                            destination_area_id: areaId,
                            destination_coordinate: { latitude: Number(targetOrder.delivery_lat), longitude: Number(targetOrder.delivery_lng) },
                            ...(targetOrder.delivery_driver_note ? { destination_note: targetOrder.delivery_driver_note } : {}),
                            // Courier defaults to grab instant
                            courier_company: 'grab',
                            courier_type: 'instant',

                            // Delivery Schedule Logic
                            delivery_type: isToday ? 'now' : 'scheduled',
                            ...(isToday ? {} : {
                                delivery_date: targetOrder.pickup_date,
                                delivery_time: targetOrder.pickup_time ? targetOrder.pickup_time.split(' ')[0] : '11:00', // Extracts HH:mm
                            }),
                            // Items
                            items: biteshipItems,
                            order_note: `RPN Order #${targetOrder.id}${targetOrder.note ? ` - ${targetOrder.note}` : ''}`,
                        };

                        await biteshipPost('/orders', payload);
                        console.log(`[Biteship] Auto-created order for RPN #${targetOrder.id}`);
                    } else {
                        console.error(`[Biteship] Order #${targetOrder.id} is store_delivery but missing coordinate/address info.`);
                    }
                }
            } catch (err: any) {
                console.error(`[Biteship] Failed to auto-create dispatch for Order #${id}:`, err?.message);
            }
        }

        // Auto-send WhatsApp if status becomes DONE
        if (status.toUpperCase() === 'DONE') {
            try {
                const waService = getWhatsAppService();
                if (waService.isConnected) {
                    // FIX: Use getOrderById instead of loading all orders
                    const targetOrder = await getOrderById(id);

                    if (targetOrder && targetOrder.customer_phone) {
                        const waMessage = buildDoneOrderMessage({
                            customer_name: targetOrder.customer_name,
                            order_id: targetOrder.id,
                        });

                        waService.sendMessage(formatWAPhone(targetOrder.customer_phone), waMessage).catch(err => {
                            console.error('Auto WA Send Error on DONE:', err);
                        });
                    }
                }
            } catch (waErr) {
                console.error('Failed to prepare auto WA message on DONE:', waErr);
            }
        }

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

router.patch('/order/:id/transfer-img-url', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }

        const { transfer_img_url } = req.body;
        if (!transfer_img_url) {
            res.status(400).json({ status: 'error', message: 'transfer_img_url wajib diisi' });
            return;
        }

        const data = await updateTransferImgUrl(id, transfer_img_url);

        // Auto-send WhatsApp after successful upload
        try {
            const waService = getWhatsAppService();
            if (waService.isConnected && data && data.customer_phone) {
                const waMessage = buildTransferReceivedMessage(data.customer_name);
                waService.sendMessage(formatWAPhone(data.customer_phone), waMessage).catch(err => {
                    console.error('Auto WA Send Error on Transfer Img Upload:', err);
                });
            }
        } catch (waErr) {
            console.error('Failed to prepare auto WA message on Transfer Img Upload:', waErr);
        }

        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(400).json({ status: 'error', message: e.message });
    }
});

export default router;
