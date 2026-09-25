import type { PoolClient } from 'pg';
import { transaction } from '../config/db';
import { resolveBoxCost, type StockUsage } from './variantRecipe.service';

/**
 * Automatic stock movements caused by orders (Fitur 3).
 *
 * Every movement is written to stock_history with order_id, so the NET effect of an order on
 * each stock item is always SUM(qty_change) for that order. That makes both operations idempotent:
 *  - apply:   only runs when the order's net effect is zero (not yet applied, or fully reversed)
 *  - reverse: puts back exactly the current net deduction
 * Both lock the order row, so concurrent apply/reverse for the same order serialize.
 *
 * Product decisions: stock is deducted as soon as the order exists (UNPAID included), may go
 * negative, and failures never block the order — callers use the *Safe variants.
 */

/** Pure: total grams per stock item for a set of order items. */
export const aggregateDeductions = (items: { qty: number; usage: StockUsage[] }[]): Map<number, number> => {
    const totals = new Map<number, number>();
    for (const item of items) {
        for (const u of item.usage) {
            totals.set(u.stock_id, (totals.get(u.stock_id) ?? 0) + u.qty_gram * item.qty);
        }
    }
    for (const [stockId, grams] of totals) {
        const rounded = Math.round(grams * 100) / 100;
        if (rounded === 0) totals.delete(stockId);
        else totals.set(stockId, rounded);
    }
    return totals;
};

const lockOrder = async (client: PoolClient, orderId: number) => {
    const { rows } = await client.query('SELECT id, status, store_id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    return rows[0] as { id: number; status: string; store_id: number | null } | undefined;
};

/** Net qty_change per stock item already booked for this order (negative = deducted). */
const netByStock = async (client: PoolClient, orderId: number) => {
    const { rows } = await client.query(
        'SELECT stock_id, SUM(qty_change) AS net FROM stock_history WHERE order_id = $1 GROUP BY stock_id',
        [orderId]
    );
    return new Map<number, number>(rows.map(r => [r.stock_id, Number(r.net)]));
};

const bookMovement = async (client: PoolClient, orderId: number, stockId: number, delta: number, notes: string) => {
    const { rows: [stock] } = await client.query(
        'UPDATE stock SET qty = qty + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING qty',
        [delta, stockId]
    );
    if (!stock) return; // stock item deleted meanwhile; nothing to book
    await client.query(
        `INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes, order_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [stockId, delta < 0 ? 'OUT' : 'IN', delta, stock.qty, notes, orderId]
    );
};

export interface StockResult {
    status: 'applied' | 'reversed' | 'skipped';
    reason?: string;
    movements: { stock_id: number; qty_change: number }[];
}

export const applyOrderStock = async (orderId: number): Promise<StockResult> =>
    transaction(async (client) => {
        const order = await lockOrder(client, orderId);
        if (!order) return { status: 'skipped', reason: 'order not found', movements: [] };
        if (order.status === 'CANCELLED') return { status: 'skipped', reason: 'order cancelled', movements: [] };
        if (!order.store_id) return { status: 'skipped', reason: 'order has no store', movements: [] };

        const net = await netByStock(client, orderId);
        if ([...net.values()].some(v => Math.abs(v) > 0.001)) return { status: 'skipped', reason: 'already applied', movements: [] };

        const { rows: items } = await client.query(`
            SELECT oi.id, oi.box_type, oi.qty,
                   COALESCE(array_agg(oiv.variant_id ORDER BY oiv.id) FILTER (WHERE oiv.variant_id IS NOT NULL), '{}') AS variant_ids
            FROM order_items oi
            LEFT JOIN order_item_variants oiv ON oiv.order_item_id = oi.id
            WHERE oi.order_id = $1
            GROUP BY oi.id
            ORDER BY oi.id
        `, [orderId]);

        const withUsage = [];
        for (const item of items) {
            if (item.variant_ids.length === 0) continue; // legacy item without variant ids
            withUsage.push({ qty: item.qty, usage: await resolveBoxCost(item.variant_ids, item.box_type, order.store_id, client) });
        }

        const movements: StockResult['movements'] = [];
        for (const [stockId, grams] of aggregateDeductions(withUsage)) {
            await bookMovement(client, orderId, stockId, -grams, `Order #${orderId}`);
            movements.push({ stock_id: stockId, qty_change: -grams });
        }
        return { status: movements.length > 0 ? 'applied' : 'skipped', reason: movements.length > 0 ? undefined : 'no recipe usage', movements };
    });

export const reverseOrderStock = async (orderId: number): Promise<StockResult> =>
    transaction(async (client) => {
        const order = await lockOrder(client, orderId);
        if (!order) return { status: 'skipped', reason: 'order not found', movements: [] };

        const movements: StockResult['movements'] = [];
        for (const [stockId, net] of await netByStock(client, orderId)) {
            const rounded = Math.round(net * 100) / 100;
            if (rounded === 0) continue;
            await bookMovement(client, orderId, stockId, -rounded, `Reversal Order #${orderId}`);
            movements.push({ stock_id: stockId, qty_change: -rounded });
        }
        return { status: movements.length > 0 ? 'reversed' : 'skipped', reason: movements.length > 0 ? undefined : 'nothing to reverse', movements };
    });

// Never let a stock problem fail an order operation: log and move on.
const safely = (label: string, fn: (orderId: number) => Promise<StockResult>) => async (orderId: number) => {
    try {
        const result = await fn(orderId);
        if (result.status !== 'skipped') {
            console.log(`[stock] ${label} order #${orderId}: ${result.movements.map(m => `stock ${m.stock_id} ${m.qty_change > 0 ? '+' : ''}${m.qty_change}`).join(', ')}`);
        }
        return result;
    } catch (err) {
        console.error(`[stock] ${label} failed for order #${orderId}`, err);
        return null;
    }
};

export const applyOrderStockSafe = safely('apply', applyOrderStock);
export const reverseOrderStockSafe = safely('reverse', reverseOrderStock);

/** Recompute an order's stock effect from its current items and recipes (reverse, then apply). */
export const recalculateOrderStock = async (orderId: number) => {
    const reversed = await reverseOrderStock(orderId);
    const applied = await applyOrderStock(orderId);
    return { reversed, applied };
};
