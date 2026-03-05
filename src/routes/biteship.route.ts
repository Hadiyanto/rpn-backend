import { Router } from 'express';
import { biteshipGet, biteshipPost } from '../utils/biteship';

const router = Router();

/** RPN Store — origin constant for all Biteship shipments */
const RPN_ORIGIN = {
    contact_name: 'RPN Store',
    contact_phone: '081314220599',
    address: 'Belakang TK Widiastuti, Jalan Rawa Jati Timur VIII, RW 08, Rawajati, Pancoran, Jakarta Selatan, DKI Jakarta 12750',
    area_id: 'IDNP6IDNC148IDND841IDZ12750',
    postal_code: 12750,
    coordinate: {
        latitude: -6.261204,
        longitude: 106.854106,
    },
} as const;

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
 * Get shipping rates. Origin always from RPN_ORIGIN (lat/lng).
 * FE cukup kirim: { destination_latitude, destination_longitude, couriers?, items }
 * items: [{ name, value, length, width, height, weight, quantity }]
 */
router.post('/biteship/rates', async (req, res) => {
    try {
        const {
            destination_latitude,
            destination_longitude,
            couriers = 'gosend,grab,gojek,jne,sicepat,jnt,anteraja,ide',
            items,
        } = req.body;

        if (!destination_latitude || !destination_longitude) {
            res.status(400).json({ status: 'error', message: 'destination_latitude dan destination_longitude wajib diisi' });
            return;
        }
        if (!items?.length) {
            res.status(400).json({ status: 'error', message: 'Field items wajib diisi' });
            return;
        }

        const ratePayload = {
            origin_latitude: RPN_ORIGIN.coordinate.latitude,
            origin_longitude: RPN_ORIGIN.coordinate.longitude,
            destination_latitude: Number(destination_latitude),
            destination_longitude: Number(destination_longitude),
            couriers,
            items,
        };

        const data = await biteshipPost('/rates/couriers', ratePayload);
        res.json({ status: 'ok', data: data.pricing ?? [] });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
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
            'destination_contact_name', 'destination_contact_phone',
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

        const payload: Record<string, any> = {
            // Shipper = toko
            shipper_contact_name: RPN_ORIGIN.contact_name,
            shipper_contact_phone: RPN_ORIGIN.contact_phone,
            // Origin = toko
            origin_contact_name: RPN_ORIGIN.contact_name,
            origin_contact_phone: RPN_ORIGIN.contact_phone,
            origin_address: RPN_ORIGIN.address,
            origin_area_id: RPN_ORIGIN.area_id,
            origin_coordinate: RPN_ORIGIN.coordinate, // required for instant couriers
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
