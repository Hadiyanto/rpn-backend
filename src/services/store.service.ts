import { NotFoundError } from '../utils/errors';
import { ValidationError } from '../utils/validation';
import { pool, updateRowById } from '../config/db';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const getStores = async () => {
    const { rows } = await pool.query('SELECT * FROM stores WHERE is_active = true ORDER BY id ASC');
    return rows;
};

export const getStoreById = async (id: number) => {
    const { rows } = await pool.query('SELECT * FROM stores WHERE id = $1', [id]);
    // supabase .single() threw when no row matched; callers rely on that.
    if (rows.length === 0) throw new NotFoundError(`Store dengan id ${id} tidak ditemukan`);
    return rows[0];
};

export interface UpdateStorePayload {
    name?: string;
    address?: string;
    area_id?: string | null;
    latitude?: number;
    longitude?: number;
    phone?: string | null;
    is_active?: boolean;
    open_time?: string;
    /** Latest pickup time ("HH:mm"); orders after it are refused. */
    last_pickup_time?: string;
    bank_name?: string | null;
    bank_account_number?: string | null;
    bank_account_name?: string | null;
    qris_image_url?: string | null;
    /** Boxes per day assumed for the HPP labor cost. */
    labor_target_boxes?: number;
    /** Store whose salary is used for this store's HPP labor cost (null = own). */
    labor_reference_store_id?: number | null;
}

export const updateStore = async (id: number, payload: UpdateStorePayload) => {
    if (payload.last_pickup_time !== undefined) {
        if (typeof payload.last_pickup_time !== 'string' || !HHMM_RE.test(payload.last_pickup_time)) {
            throw new ValidationError('Jam terakhir pickup harus berformat HH:mm');
        }
        const openTime = payload.open_time
            ?? (await pool.query('SELECT open_time FROM stores WHERE id = $1', [id])).rows[0]?.open_time;
        if (openTime && payload.last_pickup_time < openTime) {
            throw new ValidationError(`Jam terakhir pickup tidak boleh sebelum jam buka (${openTime})`);
        }
    }
    if (payload.labor_target_boxes !== undefined) {
        const n = Number(payload.labor_target_boxes);
        if (!Number.isInteger(n) || n < 1) throw new ValidationError('Target box per hari harus bilangan bulat ≥ 1');
        payload.labor_target_boxes = n;
    }
    if (payload.labor_reference_store_id !== undefined && payload.labor_reference_store_id !== null) {
        const ref = Number(payload.labor_reference_store_id);
        if (ref === id) payload.labor_reference_store_id = null; // "this store" = own salary
        else {
            const { rows } = await pool.query('SELECT labor_reference_store_id FROM stores WHERE id = $1', [ref]);
            if (rows.length === 0) throw new ValidationError('Store acuan tidak ditemukan');
            if (rows[0].labor_reference_store_id !== null) throw new ValidationError('Store acuan tidak boleh memakai acuan store lain');
            const { rowCount } = await pool.query('SELECT 1 FROM stores WHERE labor_reference_store_id = $1', [id]);
            if (rowCount) throw new ValidationError('Store ini sudah menjadi acuan store lain, jadi harus memakai gajinya sendiri');
            payload.labor_reference_store_id = ref;
        }
    }
    const data = await updateRowById('stores', id, {
        name: payload.name,
        address: payload.address,
        area_id: payload.area_id,
        latitude: payload.latitude,
        longitude: payload.longitude,
        phone: payload.phone,
        is_active: payload.is_active,
        open_time: payload.open_time,
        last_pickup_time: payload.last_pickup_time,
        bank_name: payload.bank_name,
        bank_account_number: payload.bank_account_number,
        bank_account_name: payload.bank_account_name,
        qris_image_url: payload.qris_image_url,
        labor_target_boxes: payload.labor_target_boxes,
        labor_reference_store_id: payload.labor_reference_store_id,
        updated_at: new Date().toISOString(),
    });
    if (!data) throw new NotFoundError(`Store dengan id ${id} tidak ditemukan`);
    return data;
};
