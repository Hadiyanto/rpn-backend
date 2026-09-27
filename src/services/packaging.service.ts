import type { PoolClient } from 'pg';
import { pool, transaction } from '../config/db';
import { ValidationError } from '../utils/validation';
import type { StockUsage } from './variantRecipe.service';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * "Kemasan & perlengkapan": counted items (boxes, forks, bags, stickers) used by an order.
 * The items are ordinary stock rows; packaging_rule says how many (docs/plan-stok-kemasan.md).
 */
export type PackagingMode = 'per_box' | 'per_boxes' | 'per_order';
export const PACKAGING_MODES: PackagingMode[] = ['per_box', 'per_boxes', 'per_order'];
const BOX_TYPES = ['FULL', 'HALF'];

export interface PackagingRule {
    stock_id: number;
    /** null = every box type */
    box_type: string | null;
    mode: PackagingMode;
    qty: number;
    /** per_boxes only: one unit covers this many boxes */
    boxes_per_unit: number | null;
}

/** Number of boxes per box type in one order, e.g. { FULL: 2, HALF: 1 }. */
export type BoxCounts = Record<string, number>;

/** Pure: packaging used by one order. */
export const computePackagingUsage = (rules: PackagingRule[], boxes: BoxCounts): StockUsage[] => {
    const byStock = new Map<number, number>();
    for (const rule of rules) {
        const count = rule.box_type
            ? boxes[rule.box_type] ?? 0
            : Object.values(boxes).reduce((sum, n) => sum + n, 0);
        if (count <= 0) continue;
        const units = rule.mode === 'per_box' ? count
            : rule.mode === 'per_boxes' ? Math.ceil(count / (rule.boxes_per_unit ?? 1))
            : 1;
        byStock.set(rule.stock_id, (byStock.get(rule.stock_id) ?? 0) + units * rule.qty);
    }
    return [...byStock.entries()]
        .map(([stock_id, qty_gram]) => ({ stock_id, qty_gram: Math.round(qty_gram * 10000) / 10000 }))
        .sort((a, b) => a.stock_id - b.stock_id);
};

const toRule = (r: Record<string, unknown>): PackagingRule => ({
    stock_id: Number(r.stock_id),
    box_type: (r.box_type as string | null) ?? null,
    mode: r.mode as PackagingMode,
    qty: Number(r.qty),
    boxes_per_unit: r.boxes_per_unit === null || r.boxes_per_unit === undefined ? null : Number(r.boxes_per_unit),
});

export const loadPackagingRules = async (storeId: number, db: Queryable = pool): Promise<PackagingRule[]> => {
    const { rows } = await db.query('SELECT stock_id, box_type, mode, qty, boxes_per_unit FROM packaging_rule WHERE store_id = $1', [storeId]);
    return rows.map(toRule);
};

/** Rules that scale with a single box of `boxType` (these belong in the per-box HPP). */
export const perBoxRules = (rules: PackagingRule[], boxType: string) =>
    rules.filter(r => r.mode === 'per_box' && (r.box_type === null || r.box_type === boxType));

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const getPackagingRules = async (store_id: number) => {
    if (!Number.isInteger(store_id) || store_id < 1) throw new ValidationError('store_id tidak valid');
    const { rows } = await pool.query(`
        SELECT pr.*, s.item_name, s.unit, s.price_per_unit, s.qty AS stock_qty
        FROM packaging_rule pr JOIN stock s ON s.id = pr.stock_id
        WHERE pr.store_id = $1
        ORDER BY CASE pr.mode WHEN 'per_box' THEN 0 WHEN 'per_boxes' THEN 1 ELSE 2 END, pr.box_type NULLS LAST, s.item_name
    `, [store_id]);
    return rows;
};

const parseRules = (lines: unknown): PackagingRule[] => {
    if (!Array.isArray(lines)) throw new ValidationError('items harus berupa array');
    const parsed = lines.map((raw, i) => {
        const line = (raw ?? {}) as Record<string, unknown>;
        const label = `Baris ${i + 1}`;
        const stock_id = Number(line.stock_id);
        const box_type = line.box_type === null || line.box_type === undefined || line.box_type === '' ? null : String(line.box_type).toUpperCase();
        const mode = String(line.mode) as PackagingMode;
        const qty = Number(line.qty);
        if (!Number.isInteger(stock_id) || stock_id < 1) throw new ValidationError(`${label}: barang tidak valid`);
        if (box_type !== null && !BOX_TYPES.includes(box_type)) throw new ValidationError(`${label}: jenis box tidak valid`);
        if (!PACKAGING_MODES.includes(mode)) throw new ValidationError(`${label}: cara hitung tidak valid`);
        if (!Number.isFinite(qty) || qty <= 0) throw new ValidationError(`${label}: jumlah harus > 0`);
        let boxes_per_unit: number | null = null;
        if (mode === 'per_boxes') {
            boxes_per_unit = Number(line.boxes_per_unit);
            if (!Number.isInteger(boxes_per_unit) || boxes_per_unit < 2) throw new ValidationError(`${label}: "setiap N box" harus bilangan bulat ≥ 2`);
        }
        return { stock_id, box_type, mode, qty, boxes_per_unit };
    });
    const keys = parsed.map(r => `${r.stock_id}|${r.box_type ?? ''}|${r.mode}`);
    if (new Set(keys).size !== keys.length) throw new ValidationError('Aturan yang sama untuk barang yang sama muncul dua kali');
    return parsed;
};

/** Replaces all packaging rules of a store. */
export const replacePackagingRules = async (store_id: number, lines: unknown) => {
    if (!Number.isInteger(store_id) || store_id < 1) throw new ValidationError('store_id tidak valid');
    const rules = parseRules(lines);

    await transaction(async (client) => {
        if (rules.length > 0) {
            const { rows: stocks } = await client.query('SELECT id, item_name, store_id FROM stock WHERE id = ANY($1::int[])', [rules.map(r => r.stock_id)]);
            const byId = new Map(stocks.map(s => [s.id, s]));
            for (const rule of rules) {
                const stock = byId.get(rule.stock_id);
                if (!stock) throw new ValidationError(`Stock ${rule.stock_id} tidak ditemukan`);
                if (stock.store_id !== store_id) throw new ValidationError(`${stock.item_name} bukan stok milik store ini`);
            }
        }
        await client.query('DELETE FROM packaging_rule WHERE store_id = $1', [store_id]);
        for (const r of rules) {
            await client.query(
                'INSERT INTO packaging_rule (store_id, stock_id, box_type, mode, qty, boxes_per_unit) VALUES ($1, $2, $3, $4, $5, $6)',
                [store_id, r.stock_id, r.box_type, r.mode, r.qty, r.boxes_per_unit]
            );
        }
    });
    return getPackagingRules(store_id);
};

/**
 * Copies a store's packaging rules to another store, matching items by name (missing ones are
 * created with stock 0 and the same unit). Replaces the target's rules.
 */
export const copyPackagingRules = async (fromStoreId: number, toStoreId: number): Promise<{ copied: number; created_stock: string[] }> => {
    if (!Number.isInteger(fromStoreId) || !Number.isInteger(toStoreId) || fromStoreId < 1 || toStoreId < 1) {
        throw new ValidationError('store_id asal dan tujuan wajib diisi');
    }
    if (fromStoreId === toStoreId) throw new ValidationError('Store asal dan tujuan tidak boleh sama');

    return transaction(async (client) => {
        const target = await client.query('SELECT id FROM stores WHERE id = $1', [toStoreId]);
        if (target.rowCount === 0) throw new ValidationError('Store tujuan tidak ditemukan');

        const { rows: source } = await client.query(`
            SELECT pr.box_type, pr.mode, pr.qty, pr.boxes_per_unit, s.item_name, s.unit
            FROM packaging_rule pr JOIN stock s ON s.id = pr.stock_id
            WHERE pr.store_id = $1
        `, [fromStoreId]);
        if (source.length === 0) throw new ValidationError('Belum ada aturan kemasan di store asal untuk disalin');

        const { rows: targetStock } = await client.query('SELECT id, item_name FROM stock WHERE store_id = $1', [toStoreId]);
        const byName = new Map(targetStock.map(s => [String(s.item_name).trim().toLowerCase(), s.id as number]));
        const created: string[] = [];
        for (const line of source) {
            const name = String(line.item_name).trim();
            if (byName.has(name.toLowerCase())) continue;
            const { rows: [row] } = await client.query(
                'INSERT INTO stock (item_name, unit, store_id, qty) VALUES ($1, $2, $3, 0) RETURNING id',
                [name, line.unit, toStoreId]
            );
            byName.set(name.toLowerCase(), row.id);
            created.push(name);
        }

        await client.query('DELETE FROM packaging_rule WHERE store_id = $1', [toStoreId]);
        for (const line of source) {
            await client.query(
                'INSERT INTO packaging_rule (store_id, stock_id, box_type, mode, qty, boxes_per_unit) VALUES ($1, $2, $3, $4, $5, $6)',
                [toStoreId, byName.get(String(line.item_name).trim().toLowerCase()), line.box_type, line.mode, line.qty, line.boxes_per_unit]
            );
        }
        return { copied: source.length, created_stock: created };
    });
};
