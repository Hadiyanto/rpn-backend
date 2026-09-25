import { NotFoundError } from '../utils/errors';
import { pool, updateRowById } from '../config/db';

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
    bank_name?: string | null;
    bank_account_number?: string | null;
    bank_account_name?: string | null;
    qris_image_url?: string | null;
}

export const updateStore = async (id: number, payload: UpdateStorePayload) => {
    const data = await updateRowById('stores', id, {
        name: payload.name,
        address: payload.address,
        area_id: payload.area_id,
        latitude: payload.latitude,
        longitude: payload.longitude,
        phone: payload.phone,
        is_active: payload.is_active,
        open_time: payload.open_time,
        bank_name: payload.bank_name,
        bank_account_number: payload.bank_account_number,
        bank_account_name: payload.bank_account_name,
        qris_image_url: payload.qris_image_url,
        updated_at: new Date().toISOString(),
    });
    if (!data) throw new NotFoundError(`Store dengan id ${id} tidak ditemukan`);
    return data;
};
