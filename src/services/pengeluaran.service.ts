import { pool, insertRow } from '../config/db';
import { ValidationError } from '../utils/validation';
import { ConflictError, NotFoundError } from '../utils/errors';

export interface CreatePengeluaranPayload {
    name: string;
    category?: string | null;
    price: number;
    date?: string; // ISO date e.g. '2026-02-26'
    receipt_image_url?: string | null;
    /** Store the expense belongs to; null = general (not tied to a store). */
    store_id?: number | null;
}

// Input rules for expenses (review 2026-10-19, I7); column limits from the initial schema.
const validName = (name: unknown) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 255) throw new ValidationError('Nama pengeluaran wajib diisi (maks 255 karakter)');
    return trimmed;
};
const validPrice = (price: unknown) => {
    const n = Number(price);
    if (price === null || price === '' || !Number.isFinite(n) || n <= 0 || n >= 1e10) throw new ValidationError('Nominal pengeluaran harus lebih dari 0');
    return n;
};
const validCategory = (category: unknown) => {
    if (category === undefined || category === null || category === '') return null;
    if (typeof category !== 'string' || category.length > 100) throw new ValidationError('Kategori maksimal 100 karakter');
    return category;
};
const validDate = (date: unknown) => {
    if (date === undefined || date === null || date === '') return undefined; // DB default: today
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new ValidationError('Tanggal harus berformat YYYY-MM-DD');
    }
    return date;
};
const validStoreId = (storeId: unknown) => {
    if (storeId === undefined || storeId === null || storeId === '') return null;
    const n = Number(storeId);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('store_id tidak valid');
    return n;
};

export const createPengeluaran = async (payload: CreatePengeluaranPayload) =>
    insertRow('pengeluaran', {
        name: validName(payload.name),
        price: validPrice(payload.price),
        category: validCategory(payload.category),
        date: validDate(payload.date),
        receipt_image_url: payload.receipt_image_url ?? null,
        store_id: validStoreId(payload.store_id),
    });

/** An expense row that may be changed by hand: not one booked by the daily salary (that one follows the salary). */
const editableRow = async (id: number) => {
    const { rows: [row] } = await pool.query('SELECT id, daily_salary_id FROM pengeluaran WHERE id = $1', [id]);
    if (!row) throw new NotFoundError(`Pengeluaran #${id} tidak ditemukan`);
    if (row.daily_salary_id) throw new ConflictError('Pengeluaran gaji diatur dari halaman Gaji (generate ulang gaji hari itu).');
    return row;
};

/** Fixes a wrongly entered expense; only the given fields change. */
export const updatePengeluaran = async (id: number, payload: Partial<CreatePengeluaranPayload>) => {
    await editableRow(id);
    const fields: Record<string, unknown> = {};
    if (payload.name !== undefined) fields.name = validName(payload.name);
    if (payload.price !== undefined) fields.price = validPrice(payload.price);
    if (payload.category !== undefined) fields.category = validCategory(payload.category);
    if (payload.date !== undefined) fields.date = validDate(payload.date) ?? null;
    if (payload.receipt_image_url !== undefined) fields.receipt_image_url = payload.receipt_image_url || null;
    if (payload.store_id !== undefined) fields.store_id = validStoreId(payload.store_id);
    if (fields.date === null) delete fields.date; // an empty date keeps the current one
    const columns = Object.keys(fields);
    if (columns.length === 0) throw new ValidationError('Tidak ada data yang diubah');
    // Column names come from the fixed list above, never from user input.
    const { rows: [row] } = await pool.query(
        `UPDATE pengeluaran SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [id, ...columns.map(c => fields[c])]);
    return row;
};

export const deletePengeluaran = async (id: number) => {
    await editableRow(id);
    await pool.query('DELETE FROM pengeluaran WHERE id = $1', [id]);
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
