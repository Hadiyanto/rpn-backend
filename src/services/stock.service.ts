import type { PoolClient } from 'pg';
import { pool, transaction } from '../config/db';
import { ValidationError } from '../utils/validation';
import { ConflictError, NotFoundError } from '../utils/errors';
import { isGramUnit } from './variantRecipe.service';
import { weightedAverageCost } from '../utils/stockCost';

export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT';

/**
 * Movement date from the client (ISO string). undefined → now. Stored via ::timestamptz, so it lands
 * in the DB session time zone exactly like the CURRENT_TIMESTAMP default of stock_history.created_at.
 */
const parseMovementDate = (value: unknown): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) throw new ValidationError('Tanggal tidak valid');
    if (d.getTime() > Date.now() + 60_000) throw new ValidationError('Tanggal tidak boleh di masa depan');
    return d.toISOString();
};

const isLaterMovement = async (client: PoolClient, stockId: number, isoDate: string) => {
    const { rowCount } = await client.query(
        'SELECT 1 FROM stock_history WHERE stock_id = $1 AND created_at > $2::timestamptz LIMIT 1',
        [stockId, isoDate]
    );
    return !!rowCount;
};

/**
 * Replays one stock item's history in date order and rewrites what depends on the order of events:
 * final_qty per row, unit_cost per row (so order HPP follows), and stock.qty / price_per_unit.
 * Needed after a backdated movement or an edited one. Same rules as the live code:
 *  - manual IN with total_price → moving weighted average, unit_cost = new average;
 *  - order reversal IN → back at the cost the order took it out with;
 *  - everything else → unit_cost = current average.
 * `opening` is the balance not explained by history (stock.qty − Σ qty_change before the change).
 */
export const rebuildStockLedger = async (client: PoolClient, stockId: number, opening: number) => {
    const { rows: [stock] } = await client.query('SELECT price_per_unit FROM stock WHERE id = $1 FOR UPDATE', [stockId]);
    if (!stock) return;
    const { rows } = await client.query(
        'SELECT id, type, qty_change, final_qty, total_price, unit_cost, order_id FROM stock_history WHERE stock_id = $1 ORDER BY created_at, id',
        [stockId]
    );

    let qty = opening;
    let avg: number | null = null;
    const orderOut = new Map<number, { qty: number; cost: number | null }>(); // per order: what it holds

    for (const r of rows) {
        const change = Number(r.qty_change);
        const rowCost = r.unit_cost === null ? null : Number(r.unit_cost);
        let unitCost: number | null;

        if (r.order_id === null && change > 0 && r.total_price !== null) {
            avg = weightedAverageCost(qty, avg, change, Number(r.total_price) / change);
            unitCost = avg;
        } else if (r.order_id !== null && change > 0) {
            const held = orderOut.get(r.order_id);
            const returnCost = held?.cost ?? null;
            if (returnCost !== null) avg = weightedAverageCost(qty, avg, change, returnCost);
            unitCost = returnCost ?? avg;
        } else {
            // No priced purchase seen yet (price entered on the item itself, or "Stok awal"): keep the
            // cost this row was booked with as the running cost.
            if (avg === null && rowCost !== null) avg = rowCost;
            unitCost = avg;
        }

        if (r.order_id !== null) {
            const held = orderOut.get(r.order_id) ?? { qty: 0, cost: null };
            const heldValue = held.cost === null || unitCost === null ? null : held.qty * held.cost;
            const newQty = held.qty - change; // OUT (negative change) increases what the order holds
            orderOut.set(r.order_id, {
                qty: newQty,
                cost: newQty === 0 ? null : heldValue === null || unitCost === null ? unitCost : (heldValue - change * unitCost) / newQty,
            });
        }

        qty = Math.round((qty + change) * 100) / 100;
        if (Number(r.final_qty) !== qty || rowCost !== unitCost) {
            await client.query('UPDATE stock_history SET final_qty = $2, unit_cost = $3 WHERE id = $1', [r.id, qty, unitCost]);
        }
    }

    await client.query(
        'UPDATE stock SET qty = $2, price_per_unit = COALESCE($3, price_per_unit), updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [stockId, qty, avg]
    );
};

/** Balance not explained by history; the rebuild starts from it. */
const openingBalance = async (client: PoolClient, stockId: number) => {
    const { rows: [r] } = await client.query(
        'SELECT s.qty - COALESCE((SELECT SUM(qty_change) FROM stock_history WHERE stock_id = s.id), 0) AS opening FROM stock s WHERE s.id = $1',
        [stockId]
    );
    return r ? Number(r.opening) : 0;
};

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
    /** Purchase price per unit (e.g. Rp per gram). Optional; drives HPP. */
    price_per_unit?: number | null;
    /** When the initial stock came in (ISO); default now. */
    created_at?: string | null;
}

/** undefined = not given, null = clear, otherwise a non-negative number. */
const parsePricePerUnit = (value: unknown): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('Harga per satuan tidak valid');
    return n;
};

export const createStock = async (payload: CreateStockDTO) => {
    const item_name = typeof payload.item_name === 'string' ? payload.item_name.trim() : '';
    const unit = typeof payload.unit === 'string' ? payload.unit.trim() : '';
    const store_id = Number(payload.store_id);
    const qty = payload.qty === undefined ? 0 : Number(payload.qty);

    if (!item_name) throw new ValidationError('item_name wajib diisi');
    if (!unit) throw new ValidationError('unit wajib diisi');
    if (!Number.isInteger(store_id) || store_id < 1) throw new ValidationError('store_id tidak valid');
    if (!Number.isFinite(qty)) throw new ValidationError('qty tidak valid');
    const price_per_unit = parsePricePerUnit(payload.price_per_unit) ?? null;
    const createdAt = parseMovementDate(payload.created_at);

    return transaction(async (client) => {
        const { rowCount } = await client.query(
            'SELECT 1 FROM stock WHERE store_id = $1 AND lower(item_name) = lower($2)',
            [store_id, item_name]
        );
        if (rowCount) throw new ConflictError(`Bahan "${item_name}" sudah ada di store ini`);
        const { rows: [stock] } = await client.query(
            'INSERT INTO stock (item_name, unit, store_id, qty, price_per_unit) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [item_name, unit, store_id, qty, price_per_unit]
        );
        if (qty !== 0) {
            await client.query(
                `INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes, unit_cost, created_at)
                 VALUES ($1, 'IN', $2, $2, 'Stok awal', $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP))`,
                [stock.id, qty, price_per_unit, createdAt ?? null]
            );
        }
        return stock;
    });
};

/** Rename an item or change its unit. A unit change away from gram is refused while recipes use it. */
export const updateStock = async (id: number, payload: { item_name?: unknown; unit?: unknown; price_per_unit?: unknown }) => {
    const item_name = payload.item_name === undefined ? undefined : String(payload.item_name).trim();
    const unit = payload.unit === undefined ? undefined : String(payload.unit).trim();
    if (item_name !== undefined && !item_name) throw new ValidationError('item_name tidak boleh kosong');
    if (unit !== undefined && !unit) throw new ValidationError('unit tidak boleh kosong');
    const price = parsePricePerUnit(payload.price_per_unit);

    return transaction(async (client) => {
        const { rows: [current] } = await client.query('SELECT * FROM stock WHERE id = $1 FOR UPDATE', [id]);
        if (!current) throw new NotFoundError(`Stock dengan id ${id} tidak ditemukan`);

        if (unit !== undefined && !isGramUnit(unit)) {
            const { rowCount } = await client.query(
                'SELECT 1 FROM variant_recipe WHERE stock_id = $1 UNION ALL SELECT 1 FROM base_recipe WHERE stock_id = $1 LIMIT 1',
                [id]
            );
            if (rowCount) throw new ConflictError('Bahan ini dipakai di resep, satuannya harus tetap gram');
        }

        const { rows: [updated] } = await client.query(
            `UPDATE stock
             SET item_name = COALESCE($2, item_name),
                 unit = COALESCE($3, unit),
                 price_per_unit = CASE WHEN $4 THEN $5 ELSE price_per_unit END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [id, item_name ?? null, unit ?? null, price !== undefined, price ?? null]
        );
        return updated;
    });
};

/** Delete an item (its history goes with it). Refused while a recipe still uses it. */
export const deleteStock = async (id: number) => {
    const { rows } = await pool.query(`
        SELECT DISTINCT v.variant_name
        FROM variant_recipe vr JOIN variant v ON v.id = vr.variant_id
        WHERE vr.stock_id = $1
        ORDER BY v.variant_name
    `, [id]);
    if (rows.length > 0) {
        throw new ConflictError(`Bahan masih dipakai di resep: ${rows.map(r => r.variant_name).join(', ')}. Hapus dari resep dulu.`);
    }
    const base = await pool.query('SELECT 1 FROM base_recipe WHERE stock_id = $1 LIMIT 1', [id]);
    if (base.rowCount) throw new ConflictError('Bahan masih dipakai sebagai bahan dasar box. Hapus dari bahan dasar dulu.');
    const packaging = await pool.query('SELECT 1 FROM packaging_rule WHERE stock_id = $1 LIMIT 1', [id]);
    if (packaging.rowCount) throw new ConflictError('Barang masih dipakai sebagai kemasan. Hapus dari aturan kemasan dulu.');
    const { rowCount } = await pool.query('DELETE FROM stock WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundError(`Stock dengan id ${id} tidak ditemukan`);
    return true;
};

export interface AdjustStockDTO {
    stock_id: number;
    qty_change: number; // For addition: the amount to add. For target: the final desired quantity.
    type: StockMovementType;
    is_target?: boolean; // If true, qty_change is treated as the final physical count
    notes?: string;
    /** Total paid for this stock-in. Updates price_per_unit to the moving weighted average of stock on hand + this purchase. */
    total_price?: number | null;
    /** When it happened (ISO); default now. A date before later movements re-runs the item's history. */
    created_at?: string | null;
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

    const createdAt = parseMovementDate(payload.created_at);

    return transaction(async (client) => {
        const current = await client.query('SELECT qty, price_per_unit FROM stock WHERE id = $1 FOR UPDATE', [payload.stock_id]);
        if (current.rowCount === 0) throw new ValidationError(`Stock dengan id ${payload.stock_id} tidak ditemukan`);

        // Backdated: book it at its date, then replay the item's history so balances and costs
        // after it are right. A physical count ("is_target") is relative to the stock at that date.
        if (createdAt && await isLaterMovement(client, payload.stock_id, createdAt)) {
            const opening = await openingBalance(client, payload.stock_id);
            const { rows: [before] } = await client.query(
                'SELECT $2::numeric + COALESCE(SUM(qty_change), 0) AS qty FROM stock_history WHERE stock_id = $1 AND created_at <= $3::timestamptz',
                [payload.stock_id, opening, createdAt]
            );
            const delta = payload.is_target ? qtyInput - Number(before.qty) : qtyInput;
            if (totalPrice !== null && delta <= 0) throw new ValidationError('Jumlah stok masuk harus > 0 untuk menghitung harga per satuan');
            await client.query(
                `INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes, total_price, unit_cost, created_at)
                 VALUES ($1, $2, $3, 0, $4, $5, NULL, $6::timestamptz)`,
                // A count's direction is decided at its date, not by today's stock.
                [payload.stock_id, payload.is_target ? (delta < 0 ? 'OUT' : 'IN') : payload.type, delta, payload.notes ?? null, totalPrice, createdAt]
            );
            await rebuildStockLedger(client, payload.stock_id, opening);
            const { rows: [updated] } = await client.query('SELECT * FROM stock WHERE id = $1', [payload.stock_id]);
            return updated;
        }

        const currentQty = Number(current.rows[0].qty);
        const currentCost = current.rows[0].price_per_unit === null ? null : Number(current.rows[0].price_per_unit);
        // Physical count mode stores delta = target - current so history lists stay consistent.
        const final_qty = payload.is_target ? qtyInput : currentQty + qtyInput;
        const history_qty_change = final_qty - currentQty;

        // A priced stock-in updates the moving weighted-average cost; everything else keeps it.
        let pricePerUnit: number | null = null;
        if (totalPrice !== null) {
            if (history_qty_change <= 0) throw new ValidationError('Jumlah stok masuk harus > 0 untuk menghitung harga per satuan');
            pricePerUnit = weightedAverageCost(currentQty, currentCost, history_qty_change, totalPrice / history_qty_change);
        }
        const unitCost = pricePerUnit ?? currentCost;

        await client.query(
            `INSERT INTO stock_history (stock_id, type, qty_change, final_qty, notes, total_price, unit_cost, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))`,
            [payload.stock_id, payload.type, history_qty_change, final_qty, payload.notes ?? null, totalPrice, unitCost, createdAt ?? null]
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
    // created_at_iso: the same moment as an absolute ISO time (created_at is a zone-less timestamp in
    // the DB session zone), for showing and editing it in the browser's zone.
    const { rows } = await pool.query(
        `SELECT *, to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at_iso
         FROM stock_history WHERE stock_id = $1 ORDER BY created_at DESC, id DESC`,
        [stockId]
    );
    return rows;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Movements booked by orders. Older ones (before stock_history.order_id, or of orders deleted since)
// only carry the order in their note: "Order #12" / "Reversal Order #12".
const ORDER_NOTE_RE = /^(Reversal )?Order #\d+$/;
const ORDER_MOVEMENT_SQL = `(order_id IS NOT NULL OR notes ~ '^(Reversal )?Order #[0-9]+$')`;

// Order items whose box actually uses stock $1 (same rules as the automatic deduction): its packaging,
// or — for items with flavors — the store's base recipe or one of its flavors' recipes.
const ITEM_USES_STOCK_SQL = `(
    EXISTS (SELECT 1 FROM packaging_rule pr
            WHERE pr.store_id = o.store_id AND pr.stock_id = $1 AND (pr.box_type IS NULL OR pr.box_type = oi.box_type))
    OR (EXISTS (SELECT 1 FROM order_item_variants x WHERE x.order_item_id = oi.id) AND (
        EXISTS (SELECT 1 FROM base_recipe br WHERE br.store_id = o.store_id AND br.stock_id = $1 AND br.qty_gram > 0)
        OR EXISTS (SELECT 1 FROM order_item_variants oiv
                   JOIN variant_recipe vr ON vr.variant_id = oiv.variant_id AND vr.store_id = o.store_id AND vr.stock_id = $1
                   WHERE oiv.order_item_id = oi.id)))
)`;

/** Boxes (FULL / HALF) in these orders that use stock `stockId`. */
const boxesUsingStock = async (stockId: number, orderIds: number[]) => {
    if (orderIds.length === 0) return { full: 0, half: 0 };
    const { rows } = await pool.query(
        `SELECT oi.box_type, SUM(oi.qty)::int AS qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE oi.order_id = ANY($2::int[]) AND ${ITEM_USES_STOCK_SQL}
         GROUP BY oi.box_type`,
        [stockId, orderIds]
    );
    const by = new Map(rows.map(r => [r.box_type, Number(r.qty)]));
    return { full: by.get('FULL') ?? 0, half: by.get('HALF') ?? 0 };
};

/**
 * Stock history for a period (WIB dates, inclusive) with two summaries:
 *  - ledger: by when stock moved — opening + in − out = closing; orders/boxes that took this stock then;
 *  - sales:  like the Sales page — orders with pickup_date in the period, without UNPAID/CANCELLED,
 *            that used this stock, their boxes and their net usage of it.
 */
export const getStockHistoryReport = async (stockId: number, from: string, to: string) => {
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new ValidationError('Rentang tanggal tidak valid');
    const { rows: [stock] } = await pool.query('SELECT id, item_name, unit, store_id, qty, price_per_unit FROM stock WHERE id = $1', [stockId]);
    if (!stock) throw new NotFoundError(`Stock dengan id ${stockId} tidak ditemukan`);

    // created_at is a zone-less timestamp in the session zone; compare as instants against WIB days.
    const inRange = `created_at::timestamptz >= ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta')
                     AND created_at::timestamptz < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta')`;
    const before = `created_at::timestamptz < ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta')`;

    const [{ rows }, { rows: [sum] }, { rows: ledgerOrders }] = await Promise.all([
        pool.query(
            `SELECT *, to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at_iso
             FROM stock_history WHERE stock_id = $1 AND ${inRange} ORDER BY created_at DESC, id DESC`,
            [stockId, from, to]
        ),
        pool.query(
            `SELECT
                s.qty - COALESCE((SELECT SUM(qty_change) FROM stock_history WHERE stock_id = s.id), 0)
                  + COALESCE((SELECT SUM(qty_change) FROM stock_history WHERE stock_id = s.id AND ${before}), 0) AS opening,
                COALESCE((SELECT SUM(qty_change) FROM stock_history WHERE stock_id = s.id AND qty_change > 0 AND ${inRange}), 0) AS total_in,
                COALESCE((SELECT -SUM(qty_change) FROM stock_history WHERE stock_id = s.id AND qty_change < 0 AND ${inRange}), 0) AS total_out,
                COALESCE((SELECT -SUM(qty_change) FROM stock_history WHERE stock_id = s.id AND qty_change < 0 AND ${ORDER_MOVEMENT_SQL} AND ${inRange}), 0) AS out_orders
             FROM stock s WHERE s.id = $1`,
            [stockId, from, to]
        ),
        // Orders that took this stock in the period (net, so a cancelled-and-reversed order drops out).
        pool.query(
            `SELECT order_id FROM stock_history
             WHERE stock_id = $1 AND order_id IS NOT NULL AND ${inRange}
             GROUP BY order_id HAVING SUM(qty_change) < 0`,
            [stockId, from, to]
        ),
    ]);

    // Sales view: pickup date in range, same exclusions as the Sales page.
    const { rows: salesOrders } = await pool.query(
        `SELECT o.id, -SUM(h.qty_change) AS used
         FROM orders o JOIN stock_history h ON h.order_id = o.id AND h.stock_id = $1
         WHERE o.store_id = $4 AND o.pickup_date BETWEEN $2::date AND $3::date AND o.status NOT IN ('UNPAID', 'CANCELLED')
         GROUP BY o.id HAVING SUM(h.qty_change) < 0`,
        [stockId, from, to, stock.store_id]
    );

    const r2 = (n: unknown) => Math.round(Number(n) * 100) / 100;
    const ledgerIds = ledgerOrders.map(r => r.order_id as number);
    const salesIds = salesOrders.map(r => r.id as number);
    const opening = r2(sum.opening), totalIn = r2(sum.total_in), totalOut = r2(sum.total_out);
    return {
        stock,
        from, to,
        ledger: {
            opening,
            total_in: totalIn,
            total_out: totalOut,
            out_orders: r2(sum.out_orders),
            out_manual: r2(totalOut - Number(sum.out_orders)),
            closing: r2(opening + totalIn - totalOut),
            orders: ledgerIds.length,
            boxes: await boxesUsingStock(stockId, ledgerIds),
        },
        sales: {
            orders: salesIds.length,
            boxes: await boxesUsingStock(stockId, salesIds),
            usage: r2(salesOrders.reduce((acc, r) => acc + Number(r.used), 0)),
        },
        movements: rows,
    };
};

export interface UpdateMovementDTO {
    /** Amount as entered: positive; OUT is stored negative. ADJUSTMENT keeps its sign. */
    qty?: number;
    total_price?: number | null;
    notes?: string | null;
    created_at?: string | null;
}

/**
 * Corrects a manual movement (amount, purchase price, note, date) and replays the item's history,
 * so every later balance and order cost follows. Movements made by orders can't be edited.
 */
export const updateStockMovement = async (historyId: number, payload: UpdateMovementDTO) => {
    const createdAt = parseMovementDate(payload.created_at);
    return transaction(async (client) => {
        const { rows: [row] } = await client.query('SELECT * FROM stock_history WHERE id = $1 FOR UPDATE', [historyId]);
        if (!row) throw new NotFoundError(`Riwayat stok dengan id ${historyId} tidak ditemukan`);
        if (row.order_id !== null || ORDER_NOTE_RE.test(row.notes ?? '')) throw new ConflictError('Pergerakan dari order tidak bisa diedit');

        let qtyChange = Number(row.qty_change);
        if (payload.qty !== undefined) {
            const q = Number(payload.qty);
            if (!Number.isFinite(q)) throw new ValidationError('Jumlah tidak valid');
            if (row.type === 'ADJUSTMENT') qtyChange = q;
            else {
                if (q <= 0) throw new ValidationError('Jumlah harus > 0');
                qtyChange = row.type === 'OUT' ? -q : q;
            }
        }

        let totalPrice = row.total_price === null ? null : Number(row.total_price);
        if (payload.total_price !== undefined) {
            if (payload.total_price === null || String(payload.total_price) === '') totalPrice = null;
            else {
                const t = Number(payload.total_price);
                if (!Number.isFinite(t) || t < 0) throw new ValidationError('Total harga tidak valid');
                if (row.type !== 'IN') throw new ValidationError('Harga beli hanya untuk stok masuk');
                totalPrice = t;
            }
        }

        const opening = await openingBalance(client, row.stock_id);
        await client.query(
            `UPDATE stock_history
             SET qty_change = $2, total_price = $3, notes = $4, created_at = COALESCE($5::timestamptz, created_at)
             WHERE id = $1`,
            [historyId, qtyChange, totalPrice, payload.notes === undefined ? row.notes : payload.notes, createdAt ?? null]
        );
        await rebuildStockLedger(client, row.stock_id, opening);
        const { rows: [stock] } = await client.query('SELECT * FROM stock WHERE id = $1', [row.stock_id]);
        return stock;
    });
};
