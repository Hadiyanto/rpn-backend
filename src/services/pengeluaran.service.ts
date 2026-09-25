import { pool, insertRow } from '../config/db';

export interface CreatePengeluaranPayload {
    name: string;
    category?: string | null;
    price: number;
    date?: string; // ISO date e.g. '2026-02-26'
    receipt_image_url?: string | null;
}

export const createPengeluaran = async (payload: CreatePengeluaranPayload) => {
    const { name, category, price, date, receipt_image_url } = payload;
    return insertRow('pengeluaran', {
        name,
        price,
        category,
        date: date || undefined, // empty → DB default (current_date)
        receipt_image_url,
    });
};

export const getPengeluaran = async () => {
    const { rows } = await pool.query('SELECT * FROM pengeluaran ORDER BY date DESC');
    return rows;
};
