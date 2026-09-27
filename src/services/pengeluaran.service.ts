import { pool, insertRow } from '../config/db';
import { ValidationError } from '../utils/validation';

export interface CreatePengeluaranPayload {
    name: string;
    category?: string | null;
    price: number;
    date?: string; // ISO date e.g. '2026-02-26'
    receipt_image_url?: string | null;
    /** Store the expense belongs to; null = general (not tied to a store). */
    store_id?: number | null;
}

export const createPengeluaran = async (payload: CreatePengeluaranPayload) => {
    const { name, category, price, date, receipt_image_url } = payload;
    const store_id = payload.store_id === undefined || payload.store_id === null ? null : Number(payload.store_id);
    if (store_id !== null && (!Number.isInteger(store_id) || store_id < 1)) throw new ValidationError('store_id tidak valid');
    return insertRow('pengeluaran', {
        name,
        price,
        category,
        date: date || undefined, // empty → DB default (current_date)
        receipt_image_url,
        store_id,
    });
};

/** store: undefined = all, 'general' = expenses without a store, number = that store. */
export const getPengeluaran = async (store?: number | 'general') => {
    const { rows } = store === undefined
        ? await pool.query('SELECT * FROM pengeluaran ORDER BY date DESC, id DESC')
        : store === 'general'
            ? await pool.query('SELECT * FROM pengeluaran WHERE store_id IS NULL ORDER BY date DESC, id DESC')
            : await pool.query('SELECT * FROM pengeluaran WHERE store_id = $1 ORDER BY date DESC, id DESC', [store]);
    return rows;
};
