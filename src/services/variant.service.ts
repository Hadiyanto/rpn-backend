import { pool, insertRow, updateRowById } from '../config/db';
import { ConflictError, NotFoundError } from '../utils/errors';
import { ValidationError } from '../utils/validation';

export interface VariantInput {
    variant_name?: string;
    is_active?: boolean;
    image_url?: string | null;
    store_ids?: number[];
}

/**
 * All flavors, each with `recipe_store_ids` (stores that have its recipe), `price_store_ids`
 * (stores that have a selling price) and `prices` ({ [store_id]: { price_full, price_half } }).
 */
export const getVariants = async () => {
    const { rows } = await pool.query(`
        SELECT v.*,
               COALESCE((SELECT array_agg(DISTINCT vr.store_id ORDER BY vr.store_id) FROM variant_recipe vr WHERE vr.variant_id = v.id), '{}') AS recipe_store_ids,
               COALESCE((SELECT array_agg(vp.store_id ORDER BY vp.store_id) FROM variant_price vp WHERE vp.variant_id = v.id), '{}') AS price_store_ids,
               COALESCE((SELECT json_object_agg(vp.store_id, json_build_object('price_full', vp.price_full, 'price_half', vp.price_half))
                         FROM variant_price vp WHERE vp.variant_id = v.id), '{}') AS prices
        FROM variant v
        ORDER BY v.is_active DESC, v.id
    `);
    return rows;
};

/**
 * A flavor can only be sold at a store that has its recipe (otherwise its stock can't be
 * deducted) and a selling price. Throws 409 naming what each store still needs.
 */
const assertStoresCanSell = async (variantId: number | null, storeIds: number[]) => {
    if (storeIds.length === 0) return;
    const { rows } = await pool.query(`
        SELECT s.name,
               EXISTS (SELECT 1 FROM variant_recipe vr WHERE vr.store_id = s.id AND vr.variant_id = $2) AS has_recipe,
               EXISTS (SELECT 1 FROM variant_price vp WHERE vp.store_id = s.id AND vp.variant_id = $2) AS has_price
        FROM stores s
        WHERE s.id = ANY($1::int[])
        ORDER BY s.id
    `, [storeIds, variantId ?? 0]);
    const noRecipe = rows.filter(r => !r.has_recipe).map(r => r.name);
    if (noRecipe.length > 0) {
        throw new ConflictError(`Belum ada resep rasa ini di ${noRecipe.join(', ')}. Buat atau salin resepnya dulu.`);
    }
    const noPrice = rows.filter(r => !r.has_price).map(r => r.name);
    if (noPrice.length > 0) {
        throw new ConflictError(`Belum ada harga jual rasa ini di ${noPrice.join(', ')}. Isi harganya dulu.`);
    }
};

const validateVariantFields = async (input: VariantInput, excludeId?: number) => {
    const out: Record<string, unknown> = {};

    if (input.variant_name !== undefined) {
        const name = String(input.variant_name).trim().replace(/\s+/g, ' ');
        if (!name || name.length > 255) throw new ValidationError('Nama rasa wajib diisi (maks 255 karakter)');
        // Flavor names must be unique ignoring case: order labels and name matching rely on it.
        const { rows } = await pool.query(
            'SELECT id FROM variant WHERE lower(variant_name) = lower($1) AND ($2::int IS NULL OR id <> $2)',
            [name, excludeId ?? null]
        );
        if (rows.length > 0) throw new ConflictError(`Rasa "${name}" sudah ada`);
        out.variant_name = name;
    }
    if (input.is_active !== undefined) out.is_active = !!input.is_active;
    if (input.image_url !== undefined) out.image_url = input.image_url || null;
    if (input.store_ids !== undefined) {
        if (!Array.isArray(input.store_ids) || input.store_ids.some(id => !Number.isInteger(Number(id)))) {
            throw new ValidationError('store_ids tidak valid');
        }
        out.store_ids = input.store_ids.map(Number);
    }
    return out;
};

/** New flavors start unsold everywhere: they become available per store once that store has their recipe. */
export const createVariant = async (input: VariantInput) => {
    if (input.variant_name === undefined) throw new ValidationError('Nama rasa wajib diisi');
    const fields = await validateVariantFields(input);
    await assertStoresCanSell(null, (fields.store_ids as number[] | undefined) ?? []);
    return insertRow('variant', { is_active: true, store_ids: [], ...fields });
};

export const updateVariant = async (id: number, updates: VariantInput) => {
    const fields = await validateVariantFields(updates, id);
    if (fields.store_ids) await assertStoresCanSell(id, fields.store_ids as number[]);
    const data = await updateRowById('variant', id, fields);
    if (!data) throw new NotFoundError(`Variant dengan id ${id} tidak ditemukan`);
    return data;
};

/**
 * Deletes a flavor and its recipes. A flavor that already appears in orders can't be deleted
 * (order history must stay intact) — deactivate it instead.
 */
export const deleteVariant = async (id: number) => {
    const { rows: used } = await pool.query('SELECT 1 FROM order_item_variants WHERE variant_id = $1 LIMIT 1', [id]);
    if (used.length > 0) {
        throw new ConflictError('Rasa ini sudah pernah dipesan, jadi tidak bisa dihapus. Nonaktifkan saja supaya tidak muncul lagi di pilihan.');
    }
    const { rowCount } = await pool.query('DELETE FROM variant WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundError(`Variant dengan id ${id} tidak ditemukan`);
    return true;
};

/**
 * Flavors ranked by boxes sold at a store over the last `days` days (cancelled orders excluded).
 * Used to order the customer gallery and mark "Terlaris"; empty when nothing has sold yet.
 */
export const getBestSellers = async (storeId: number, days = 30) => {
    if (!Number.isInteger(storeId) || storeId < 1) throw new ValidationError('store_id tidak valid');
    const window = Number.isInteger(days) && days > 0 && days <= 365 ? days : 30;
    const { rows } = await pool.query(`
        SELECT oiv.variant_id, SUM(oi.qty)::int AS sold
        FROM order_item_variants oiv
        JOIN order_items oi ON oi.id = oiv.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE o.store_id = $1 AND o.status <> 'CANCELLED'
          AND o.created_at >= CURRENT_TIMESTAMP - make_interval(days => $2)
        GROUP BY oiv.variant_id
        ORDER BY sold DESC, oiv.variant_id
    `, [storeId, window]);
    return rows as { variant_id: number; sold: number }[];
};

