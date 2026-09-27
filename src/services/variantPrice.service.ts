import type { PoolClient } from 'pg';
import { pool, transaction } from '../config/db';
import { ValidationError, validateOrderItems, validateStoreId } from '../utils/validation';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Selling price per flavor per store (docs/plan-harga-per-rasa.md).
 * - A box costs the price of its most expensive flavor (Choco + Choco Cheese → Choco Cheese).
 * - No price for a box type at a store → that flavor can't be sold in that box type there.
 */
export interface FlavorPrice {
    variant_id: number;
    variant_name?: string;
    price_full: number | null;
    price_half: number | null;
}

export interface BoxPrice {
    unit_price: number;
    /** The flavor whose price set the box price. */
    price_variant_id: number;
}

const priceFor = (p: FlavorPrice | undefined, boxType: string) =>
    (boxType === 'HALF' ? p?.price_half : p?.price_full) ?? null;

/** Pure: price of one box. Throws when a flavor has no price for this box type. */
export const computeBoxPrice = (variantIds: number[], boxType: string, prices: Map<number, FlavorPrice>, label = 'Item'): BoxPrice => {
    if (variantIds.length === 0) throw new ValidationError(`${label}: pilih minimal 1 rasa`);
    let best: BoxPrice | null = null;
    for (const id of variantIds) {
        const price = priceFor(prices.get(id), boxType);
        if (price === null) {
            const name = prices.get(id)?.variant_name ?? `#${id}`;
            throw new ValidationError(`${label}: rasa ${name} belum ada harga ${boxType === 'HALF' ? 'Box Kecil' : 'Box Besar'} di store ini`);
        }
        if (!best || price > best.unit_price) best = { unit_price: price, price_variant_id: id };
    }
    return best!;
};

const toFlavorPrice = (r: Record<string, unknown>): FlavorPrice => ({
    variant_id: Number(r.variant_id),
    variant_name: (r.variant_name as string) ?? undefined,
    price_full: r.price_full === null || r.price_full === undefined ? null : Number(r.price_full),
    price_half: r.price_half === null || r.price_half === undefined ? null : Number(r.price_half),
});

export const loadPriceMap = async (storeId: number, variantIds: number[], db: Queryable = pool) => {
    const { rows } = await db.query(`
        SELECT v.id AS variant_id, v.variant_name, vp.price_full, vp.price_half
        FROM variant v LEFT JOIN variant_price vp ON vp.variant_id = v.id AND vp.store_id = $1
        WHERE v.id = ANY($2::int[])
    `, [storeId, variantIds]);
    return new Map(rows.map(r => [Number(r.variant_id), toFlavorPrice(r)]));
};

/**
 * Prices every order item at a store. Items without variant_ids (legacy/manual) fall back to the
 * menu price of their box type.
 */
export const priceOrderItems = async (
    storeId: number,
    items: { box_type: string; variant_ids?: number[] }[],
    db: Queryable = pool,
): Promise<(BoxPrice | { unit_price: number; price_variant_id: null })[]> => {
    const ids = [...new Set(items.flatMap(i => i.variant_ids ?? []))];
    const prices = await loadPriceMap(storeId, ids, db);
    const { rows: menus } = await db.query(
        'SELECT DISTINCT ON (name) name, price FROM menu ORDER BY name, is_active DESC NULLS LAST, id'
    );
    const menuPrice = new Map(menus.map(m => [m.name, Number(m.price)]));
    return items.map((item, idx) => item.variant_ids && item.variant_ids.length > 0
        ? computeBoxPrice(item.variant_ids, item.box_type, prices, `Item ${idx + 1}`)
        : { unit_price: menuPrice.get(item.box_type) ?? 0, price_variant_id: null });
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const getVariantPrices = async (storeId: number) => {
    if (!Number.isInteger(storeId) || storeId < 1) throw new ValidationError('store_id tidak valid');
    const { rows } = await pool.query('SELECT * FROM variant_price WHERE store_id = $1 ORDER BY variant_id', [storeId]);
    return rows.map(toFlavorPrice);
};

const parsePrice = (value: unknown, label: string): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label} tidak valid`);
    return n;
};

/**
 * Sets a flavor's prices at a store. Clearing both prices stops selling it there (like an empty
 * recipe does).
 */
export const setVariantPrice = async (variantId: number, storeId: number, input: { price_full?: unknown; price_half?: unknown }) => {
    if (!Number.isInteger(variantId) || variantId < 1) throw new ValidationError('variant_id tidak valid');
    if (!Number.isInteger(storeId) || storeId < 1) throw new ValidationError('store_id tidak valid');
    const price_full = parsePrice(input.price_full, 'Harga Box Besar');
    const price_half = parsePrice(input.price_half, 'Harga Box Kecil');

    return transaction(async (client) => {
        const variant = await client.query('SELECT id FROM variant WHERE id = $1', [variantId]);
        if (variant.rowCount === 0) throw new ValidationError(`Variant ${variantId} tidak ditemukan`);
        if (price_full === null && price_half === null) {
            await client.query('DELETE FROM variant_price WHERE variant_id = $1 AND store_id = $2', [variantId, storeId]);
            await client.query('UPDATE variant SET store_ids = array_remove(store_ids, $2) WHERE id = $1', [variantId, storeId]);
            return { variant_id: variantId, store_id: storeId, price_full: null, price_half: null };
        }
        const { rows: [row] } = await client.query(`
            INSERT INTO variant_price (variant_id, store_id, price_full, price_half)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (variant_id, store_id) DO UPDATE
            SET price_full = EXCLUDED.price_full, price_half = EXCLUDED.price_half, updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [variantId, storeId, price_full, price_half]);
        return { ...toFlavorPrice(row), store_id: storeId };
    });
};

/** Copies prices of `variantIds` from one store to another (inside the recipe copy transaction). */
export const copyVariantPrices = async (client: Queryable, fromStoreId: number, toStoreId: number, variantIds: number[]) => {
    await client.query(`
        INSERT INTO variant_price (variant_id, store_id, price_full, price_half)
        SELECT variant_id, $2, price_full, price_half FROM variant_price
        WHERE store_id = $1 AND variant_id = ANY($3::int[])
        ON CONFLICT (variant_id, store_id) DO UPDATE
        SET price_full = EXCLUDED.price_full, price_half = EXCLUDED.price_half, updated_at = CURRENT_TIMESTAMP
    `, [fromStoreId, toStoreId, variantIds]);
};

/** Price preview for the order form: same rules as createOrder (box = most expensive flavor). */
export const quoteOrder = async (storeIdRaw: unknown, pesanan: unknown) => {
    const storeId = validateStoreId(storeIdRaw);
    const items = validateOrderItems(pesanan);
    const prices = await priceOrderItems(storeId, items);
    const lines = items.map((item, i) => ({ box_type: item.box_type, qty: item.qty, variant_ids: item.variant_ids ?? [], ...prices[i], subtotal: prices[i].unit_price * item.qty }));
    return { items: lines, total_amount: lines.reduce((sum, l) => sum + l.subtotal, 0) };
};
