import { Router } from 'express';
import { sendError } from '../utils/errors';
import { biteshipGet, biteshipPost } from '../utils/biteship';
import { getStoreById } from '../services/store.service';

const router = Router();

/**
 * GET /api/biteship/areas?search=jakarta+selatan
 * Search Biteship area by keyword.
 * Returns full area objects including: id, name, postal_code, administrative_division_level_*
 */
router.get('/biteship/areas', async (req, res) => {
    try {
        const { search } = req.query;
        if (!search) {
            res.status(400).json({ status: 'error', message: 'Parameter search wajib diisi' });
            return;
        }
        const data = await biteshipGet(`/maps/areas?countries=ID&input=${encodeURIComponent(String(search))}&type=single`);
        res.json({ status: 'ok', data: data.areas ?? [] });
    } catch (e: any) {
        sendError(res, e);
    }
});

/**
 * POST /api/biteship/rates
 * Get shipping rates. Origin always from RPN_ORIGIN (lat/lng).
 * FE cukup kirim: { destination_latitude, destination_longitude, couriers?, items }
 * items: [{ name, value, length, width, height, weight, quantity }]
 */
router.post('/biteship/rates', async (req, res) => {
    try {
        const {
            store_id,
            destination_latitude,
            destination_longitude,
            couriers = 'gosend,grab,gojek,jne,sicepat,jnt,anteraja,ide',
            items,
        } = req.body;

        if (!store_id) {
            res.status(400).json({ status: 'error', message: 'store_id wajib diisi' });
            return;
        }
        if (!destination_latitude || !destination_longitude) {
            res.status(400).json({ status: 'error', message: 'destination_latitude dan destination_longitude wajib diisi' });
            return;
        }
        if (!items?.length) {
            res.status(400).json({ status: 'error', message: 'Field items wajib diisi' });
            return;
        }

        const originStore = await getStoreById(store_id);
        const ratePayload = {
            origin_latitude: Number(originStore.latitude),
            origin_longitude: Number(originStore.longitude),
            destination_latitude: Number(destination_latitude),
            destination_longitude: Number(destination_longitude),
            couriers,
            items,
        };

        const data = await biteshipPost('/rates/couriers', ratePayload);
        res.json({ status: 'ok', data: data.pricing ?? [] });
    } catch (e: any) {
        sendError(res, e);
    }
});




/**
 * POST /api/biteship/order
 * Create a Biteship shipment order.
 * Origin is always RPN store (hardcoded). Only destination + courier details needed from body.
 *
 * Required body fields:
 *   destination_contact_name, destination_contact_phone, destination_address,
 *   destination_area_id, courier_company, courier_type, items
 *
 * Optional:
 *   delivery_type (default: 'now', set to 'scheduled' for scheduled delivery),
 *   delivery_date ('YYYY-MM-DD'), delivery_time ('HH:mm'),
 *   destination_coordinate { latitude, longitude },
 *   destination_note, order_note, notes
 */
router.post('/biteship/order', async (req, res) => {
    try {
        const {
            store_id,
            destination_contact_name,
            destination_contact_phone,
            destination_address,
            destination_area_id,
            destination_note,
            destination_coordinate,
            courier_company,
            courier_type,
            delivery_type = 'now',
            delivery_date,
            delivery_time,
            order_note,
            items,
        } = req.body;

        const required = [
            'store_id', 'destination_contact_name', 'destination_contact_phone',
            'destination_address', 'destination_area_id',
            'courier_company', 'courier_type',
        ];

        const missing = required.filter(k => !req.body[k]);
        if (missing.length > 0 || !items?.length) {
            res.status(400).json({
                status: 'error',
                message: `Field wajib: ${[...missing, items?.length ? '' : 'items'].filter(Boolean).join(', ')}`,
            });
            return;
        }

        const originStore = await getStoreById(store_id);
        const payload: Record<string, any> = {
            // Shipper = toko asal (per store_id)
            shipper_contact_name: originStore.name,
            shipper_contact_phone: originStore.phone,
            // Origin = toko asal
            origin_contact_name: originStore.name,
            origin_contact_phone: originStore.phone,
            origin_address: originStore.address,
            origin_area_id: originStore.area_id,
            origin_coordinate: { latitude: Number(originStore.latitude), longitude: Number(originStore.longitude) }, // required for instant couriers
            // Destination
            destination_contact_name,
            destination_contact_phone,
            destination_address,
            destination_area_id,
            // Courier
            courier_company,
            courier_type,
            delivery_type,
            // Items
            items,
            // Optionals
            ...(delivery_date ? { delivery_date } : {}),
            ...(delivery_time ? { delivery_time } : {}),
            ...(destination_note ? { destination_note } : {}),
            ...(destination_coordinate ? { destination_coordinate } : {}),
            ...(order_note ? { order_note } : {}),
        };

        const data = await biteshipPost('/orders', payload);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

/**
 * GET /api/biteship/order/:id
 * Track a Biteship order by ID.
 */
router.get('/biteship/order/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await biteshipGet(`/orders/${id}`);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
