import { Router } from 'express';
import { biteshipGet, biteshipPost } from '../utils/biteship';

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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

/**
 * POST /api/biteship/rates
 * Get shipping rates. Auto-detects mode from body fields:
 *
 * Mode 1 — By Coordinates (Low accuracy, supports instant: Gojek, Grab, Paxel etc.)
 *   Body: { origin_latitude, origin_longitude, destination_latitude, destination_longitude, couriers, items }
 *
 * Mode 2 — By Postal Code (Medium accuracy, no instant)
 *   Body: { origin_postal_code, destination_postal_code, couriers, items }
 *
 * Mode 3 — By Area ID (High accuracy, no instant)
 *   Body: { origin_area_id, destination_area_id, couriers, items }
 *
 * items: [{ name, value, length, width, height, weight, quantity, description? }]
 */
router.post('/biteship/rates', async (req, res) => {
    try {
        const {
            // Mode 1: lat/lng
            origin_latitude, origin_longitude,
            destination_latitude, destination_longitude,
            // Mode 2: postal code
            origin_postal_code, destination_postal_code,
            // Mode 3: area ID
            origin_area_id, destination_area_id,
            // Common
            couriers = 'gosend,grab_express,gojek,jne,sicepat,jnt,anteraja,ide',
            items,
        } = req.body;

        if (!items?.length) {
            res.status(400).json({ status: 'error', message: 'Field items wajib diisi' });
            return;
        }

        let ratePayload: Record<string, any> = { couriers, items };

        if (origin_latitude && origin_longitude && destination_latitude && destination_longitude) {
            // Mode 1 — Coordinates: supports instant couriers (Gojek, Grab, etc)
            ratePayload = {
                ...ratePayload,
                origin_latitude: Number(origin_latitude),
                origin_longitude: Number(origin_longitude),
                destination_latitude: Number(destination_latitude),
                destination_longitude: Number(destination_longitude),
            };
        } else if (origin_postal_code && destination_postal_code) {
            // Mode 2 — Postal code: medium accuracy
            ratePayload = {
                ...ratePayload,
                origin_postal_code: Number(origin_postal_code),
                destination_postal_code: Number(destination_postal_code),
            };
        } else if (origin_area_id && destination_area_id) {
            // Mode 3 — Area ID: highest accuracy
            ratePayload = { ...ratePayload, origin_area_id, destination_area_id };
        } else {
            res.status(400).json({
                status: 'error',
                message: 'Wajib menyertakan salah satu mode: ' +
                    '(origin/destination_latitude+longitude) | ' +
                    '(origin/destination_postal_code) | ' +
                    '(origin/destination_area_id)',
            });
            return;
        }

        const data = await biteshipPost('/rates/couriers', ratePayload);
        res.json({ status: 'ok', data: data.pricing ?? [] });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

/**
 * POST /api/biteship/order
 * Create a Biteship shipment order.
 */
router.post('/biteship/order', async (req, res) => {
    try {
        const {
            shipper_contact_name,
            shipper_contact_phone,
            origin_contact_name,
            origin_contact_phone,
            origin_address,
            origin_area_id,
            destination_contact_name,
            destination_contact_phone,
            destination_address,
            destination_area_id,
            courier_company,
            courier_type,
            items,
            notes,
        } = req.body;

        const required = [
            'origin_contact_name', 'origin_contact_phone', 'origin_address', 'origin_area_id',
            'destination_contact_name', 'destination_contact_phone', 'destination_address', 'destination_area_id',
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

        const payload = {
            shipper_contact_name: shipper_contact_name || origin_contact_name,
            shipper_contact_phone: shipper_contact_phone || origin_contact_phone,
            origin_contact_name,
            origin_contact_phone,
            origin_address,
            origin_area_id,
            destination_contact_name,
            destination_contact_phone,
            destination_address,
            destination_area_id,
            courier_company,
            courier_type,
            delivery_type: 'now',
            items,
            ...(notes ? { notes } : {}),
        };

        const data = await biteshipPost('/orders', payload);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
