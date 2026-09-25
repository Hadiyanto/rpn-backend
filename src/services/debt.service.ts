import { pool, insertRow, updateRowById } from '../config/db';
import { NotFoundError } from '../utils/errors';

export interface CreateDebtPayload {
    source: string;
    total_amount: number;
    remaining_amount: number;
    status?: 'ACTIVE' | 'PAID';
}

export interface UpdateDebtPayload {
    source?: string;
    total_amount?: number;
    remaining_amount?: number;
    status?: 'ACTIVE' | 'PAID';
}

export const getDebts = async () => {
    const { rows } = await pool.query('SELECT * FROM debt ORDER BY created_at DESC');
    return rows;
};

export const createDebt = async (payload: CreateDebtPayload) =>
    insertRow('debt', {
        source: payload.source,
        total_amount: payload.total_amount,
        remaining_amount: payload.remaining_amount,
        status: payload.status ?? 'ACTIVE',
    });

export const updateDebt = async (id: number, payload: UpdateDebtPayload) => {
    const data = await updateRowById('debt', id, {
        source: payload.source,
        total_amount: payload.total_amount,
        remaining_amount: payload.remaining_amount,
        status: payload.status,
    });
    if (!data) throw new NotFoundError(`Debt dengan id ${id} tidak ditemukan`);
    return data;
};

export const deleteDebt = async (id: number) => {
    await pool.query('DELETE FROM debt WHERE id = $1', [id]);
    return true;
};
