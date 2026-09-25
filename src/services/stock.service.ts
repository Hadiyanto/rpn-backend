import { pool, transaction } from '../config/db';
import { ValidationError } from '../utils/validation';

export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT';

export const getStocks = async (store_id?: number) => {
    const { rows } = store_id
        ? await pool.query('SELECT * FROM stock WHERE store_id = $1 ORDER BY item_name', [store_id])
        : await pool.query('SELECT * FROM stock ORDER BY item_name');
    return rows;
};

export interface CreateStockDTO {
    item_name: string;
    unit: string;
    store_id: number;
    qty?: number;
}

export const createStock = async (payload: CreateStockDTO) => {
    const item_name = typeof payload.item_name === 'string' ? payload.item_name.trim() : '';
    const unit = typeof payload.unit === 'string' ? payload.unit.trim() : '';
    const store_id = Number(payload.store_id);
    const qty = payload.qty === undefined ? 0 : Number(payload.qty);

    if (!item_name) throw new ValidationError('item_name wajib diisi');
    if (!unit) throw new ValidationError('unit wajib diisi');
    if (!Number.isInteger(store_id) || store_id < 1) throw new ValidationError('store_id tidak valid');
    if (!Number.isFinite(qty)) throw new ValidationError('qty tidak valid');

    return transaction(async (client) => {
        const { rows: [stock] } = await client.query(
            'INSERT INTO stock (item_name, unit, store_id, qty) VALUES ($1, $2, $3, $4) RETURNING *',
            [item_name, unit, store_id, qty]
        );
        if (qty !== 0) {
            await client.query(
                `INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes)
                 VALUES ($1, 'IN', $2, $2, 'Stok awal')`,
                [stock.id, qty]
            );
        }
        return stock;
    });
};

export interface AdjustStockDTO {
    stock_id: number;
    qty_change: number; // For addition: the amount to add. For target: the final desired quantity.
    type: StockMovementType;
    is_target?: boolean; // If true, qty_change is treated as the final physical count
    notes?: string;
    /** Total paid for this stock-in. Sets price_per_unit = total_price / qty added (latest purchase wins). */
    total_price?: number | null;
}

/**
 * Manual stock movement. Runs in one transaction with the row locked, so it can't race
 * with automatic order deductions (the old supabase-js read → compute → write could lose
 * one of two concurrent updates).
 */
export const adjustStock = async (payload: AdjustStockDTO) => {
    const qtyInput = Number(payload.qty_change);
    if (!Number.isFinite(qtyInput)) throw new ValidationError('qty_change tidak valid');
    if (!['IN', 'OUT', 'ADJUSTMENT'].includes(payload.type)) throw new ValidationError('type tidak valid');

    const hasPrice = payload.total_price !== undefined && payload.total_price !== null && String(payload.total_price) !== '';
    const totalPrice = hasPrice ? Number(payload.total_price) : null;
    if (hasPrice) {
        if (!Number.isFinite(totalPrice) || totalPrice! < 0) throw new ValidationError('total_price tidak valid');
        if (payload.type !== 'IN' || payload.is_target) {
            throw new ValidationError('Harga beli hanya bisa diisi untuk stok masuk (tambah stok)');
        }
    }

    return transaction(async (client) => {
        const current = await client.query('SELECT qty FROM stock WHERE id = $1 FOR UPDATE', [payload.stock_id]);
        if (current.rowCount === 0) throw new ValidationError(`Stock dengan id ${payload.stock_id} tidak ditemukan`);

        const currentQty = Number(current.rows[0].qty);
        // Physical count mode stores delta = target - current so history lists stay consistent.
        const final_qty = payload.is_target ? qtyInput : currentQty + qtyInput;
        const history_qty_change = final_qty - currentQty;

        let pricePerUnit: number | null = null;
        if (totalPrice !== null) {
            if (history_qty_change <= 0) throw new ValidationError('Jumlah stok masuk harus > 0 untuk menghitung harga per satuan');
            pricePerUnit = totalPrice / history_qty_change;
        }

        await client.query(
            'INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes, total_price) VALUES ($1, $2, $3, $4, $5, $6)',
            [payload.stock_id, payload.type, history_qty_change, final_qty, payload.notes ?? null, totalPrice]
        );

        const { rows: [updated] } = await client.query(
            `UPDATE stock
             SET qty = $1,
                 price_per_unit = COALESCE($3, price_per_unit),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [final_qty, payload.stock_id, pricePerUnit]
        );
        return updated;
    });
};

export const getStockHistory = async (stockId: number) => {
    const { rows } = await pool.query(
        'SELECT * FROM stock_history WHERE stock_id = $1 ORDER BY created_at DESC',
        [stockId]
    );
    return rows;
};
