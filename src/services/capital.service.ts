import { pool, insertRow, updateRowById } from '../config/db';
import { NotFoundError } from '../utils/errors';

export interface CreateCapitalPayload {
    amount: number;
    note?: string;
}

export interface UpdateCapitalPayload {
    amount?: number;
    note?: string;
}

export const getCapitals = async () => {
    const { rows } = await pool.query('SELECT * FROM capital ORDER BY created_at DESC');
    return rows;
};

export const createCapital = async (payload: CreateCapitalPayload) =>
    insertRow('capital', { amount: payload.amount, note: payload.note });

export const updateCapital = async (id: number, payload: UpdateCapitalPayload) => {
    const data = await updateRowById('capital', id, { amount: payload.amount, note: payload.note });
    if (!data) throw new NotFoundError(`Capital dengan id ${id} tidak ditemukan`);
    return data;
};

export const deleteCapital = async (id: number) => {
    await pool.query('DELETE FROM capital WHERE id = $1', [id]);
    return true;
};
