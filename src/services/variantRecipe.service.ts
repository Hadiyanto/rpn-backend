import type { PoolClient } from 'pg';
import { pool, transaction } from '../config/db';
import { ValidationError } from '../utils/validation';

type Queryable = Pick<PoolClient, 'query'>;

// Recipes are entered in grams; only stock items tracked in grams may be used.
const GRAM_UNITS = ['gram', 'g', 'gr'];
export const isGramUnit = (unit: string | null | undefined) => GRAM_UNITS.includes((unit ?? '').trim().toLowerCase());

// Fallback when a menu row has no box_multiplier yet.
const DEFAULT_MULTIPLIER: Record<string, number> = { FULL: 1, HALF: 0.5 };

export interface RecipeLine {
    stock_id: number;
    qty_gram: number;
}

export interface StockUsage {
    stock_id: number;
    qty_gram: number;
}

/**
 * Pure core of the "stock per box" rule (shared by HPP and auto-deduction):
 *  1. Preset mixes expand into their component flavors.
 *  2. Each leaf flavor gets weight 1/N of the box.
 *  3. Recipes are defined per FULL box; box_multiplier scales them (HALF = 0.5).
 * Flavors without a recipe simply contribute nothing.
 */
export const computeBoxCost = (
    variantIds: number[],
    boxMultiplier: number,
    components: Map<number, number[]>,
    recipes: Map<number, RecipeLine[]>,
): StockUsage[] => {
    const leaves = variantIds.flatMap(id => {
        const parts = components.get(id);
        return parts && parts.length > 0 ? parts : [id];
    });
    if (leaves.length === 0) return [];

    const weight = 1 / leaves.length;
    const byStock = new Map<number, number>();
    for (const leaf of leaves) {
        for (const line of recipes.get(leaf) ?? []) {
            byStock.set(line.stock_id, (byStock.get(line.stock_id) ?? 0) + line.qty_gram * boxMultiplier * weight);
        }
    }

    return [...byStock.entries()]
        .map(([stock_id, qty_gram]) => ({ stock_id, qty_gram: Math.round(qty_gram * 10000) / 10000 }))
        .sort((a, b) => a.stock_id - b.stock_id);
};

const loadComponents = async (db: Queryable, variantIds: number[]) => {
    const components = new Map<number, number[]>();
    if (variantIds.length === 0) return components;
    const { rows } = await db.query(
        'SELECT variant_id, component_variant_id FROM variant_components WHERE variant_id = ANY($1::int[]) ORDER BY component_variant_id',
        [variantIds]
    );
    for (const row of rows) {
        components.set(row.variant_id, [...(components.get(row.variant_id) ?? []), row.component_variant_id]);
    }
    return components;
};

export const getBoxMultiplier = async (db: Queryable, boxType: string) => {
    const { rows } = await db.query('SELECT box_multiplier FROM menu WHERE name = $1 ORDER BY is_active DESC NULLS LAST LIMIT 1', [boxType]);
    return rows[0] ? Number(rows[0].box_multiplier) : (DEFAULT_MULTIPLIER[boxType] ?? 1);
};

/** Grams of each stock item used by ONE box of `boxType` made of `variantIds` at `storeId`. */
export const resolveBoxCost = async (
    variantIds: number[],
    boxType: string,
    storeId: number,
    db: Queryable = pool,
): Promise<StockUsage[]> => {
    if (variantIds.length === 0) return [];

    const components = await loadComponents(db, variantIds);
    const leafIds = [...new Set(variantIds.flatMap(id => components.get(id) ?? [id]))];

    const { rows } = await db.query(
        'SELECT variant_id, stock_id, qty_gram FROM variant_recipe WHERE store_id = $1 AND variant_id = ANY($2::int[])',
        [storeId, leafIds]
    );
    const recipes = new Map<number, RecipeLine[]>();
    for (const row of rows) {
        recipes.set(row.variant_id, [...(recipes.get(row.variant_id) ?? []), { stock_id: row.stock_id, qty_gram: Number(row.qty_gram) }]);
    }

    return computeBoxCost(variantIds, await getBoxMultiplier(db, boxType), components, recipes);
};

// ---------------------------------------------------------------------------
// HPP (cost of goods per box)
// ---------------------------------------------------------------------------

export interface HppLine {
    stock_id: number;
    item_name: string;
    qty_gram: number;
    price_per_unit: number | null;
    subtotal: number;
}

export interface HppResult {
    hpp: number;
    breakdown: HppLine[];
    /** Stock items used by the recipe that have no purchase price yet (counted as 0). */
    missing_price: number[];
}

/** Pure: prices a box's stock usage. Missing prices count as 0 but are reported. */
export const computeHpp = (
    usage: StockUsage[],
    stocks: Map<number, { item_name: string; price_per_unit: number | null }>,
): HppResult => {
    const breakdown = usage.map(u => {
        const stock = stocks.get(u.stock_id);
        const price = stock?.price_per_unit ?? null;
        return {
            stock_id: u.stock_id,
            item_name: stock?.item_name ?? `#${u.stock_id}`,
            qty_gram: u.qty_gram,
            price_per_unit: price,
            subtotal: Math.round(u.qty_gram * (price ?? 0) * 100) / 100,
        };
    });
    return {
        hpp: Math.round(breakdown.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100,
        breakdown,
        missing_price: breakdown.filter(l => l.price_per_unit === null).map(l => l.stock_id),
    };
};

export const getVariantHpp = async (variantIds: number[], boxType: string, storeId: number): Promise<HppResult> => {
    const usage = await resolveBoxCost(variantIds, boxType, storeId);
    if (usage.length === 0) return { hpp: 0, breakdown: [], missing_price: [] };

    const { rows } = await pool.query(
        'SELECT id, item_name, price_per_unit FROM stock WHERE id = ANY($1::int[])',
        [usage.map(u => u.stock_id)]
    );
    const stocks = new Map(rows.map(r => [r.id, { item_name: r.item_name, price_per_unit: r.price_per_unit === null ? null : Number(r.price_per_unit) }]));
    return computeHpp(usage, stocks);
};

// ---------------------------------------------------------------------------
// Variant selection validation (used by createOrder/updateOrder)
// ---------------------------------------------------------------------------

export interface VariantCatalog {
    activeIds: Set<number>;
    presetIds: Set<number>;
    maxFlavors: Map<string, number>;
}

/** Pure check of one order item's variant_ids against the catalog. */
export const checkVariantSelection = (variantIds: unknown, boxType: string, catalog: VariantCatalog, label = 'Item'): number[] => {
    if (!Array.isArray(variantIds) || variantIds.length === 0) {
        throw new ValidationError(`${label}: pilih minimal 1 rasa`);
    }
    const ids = variantIds.map(Number);
    if (ids.some(id => !Number.isInteger(id) || id < 1)) {
        throw new ValidationError(`${label}: variant_ids tidak valid`);
    }
    if (new Set(ids).size !== ids.length) {
        throw new ValidationError(`${label}: rasa tidak boleh dipilih dua kali`);
    }
    const inactive = ids.filter(id => !catalog.activeIds.has(id));
    if (inactive.length > 0) {
        throw new ValidationError(`${label}: rasa tidak tersedia (id ${inactive.join(', ')})`);
    }
    const hasPreset = ids.some(id => catalog.presetIds.has(id));
    if (hasPreset && ids.length > 1) {
        throw new ValidationError(`${label}: paket mix tidak bisa dicampur dengan rasa lain`);
    }
    const max = catalog.maxFlavors.get(boxType) ?? 1;
    if (!hasPreset && ids.length > max) {
        throw new ValidationError(`${label}: maksimal ${max} rasa untuk box ${boxType}`);
    }
    return ids;
};

export const loadVariantCatalog = async (db: Queryable = pool): Promise<VariantCatalog> => {
    const [variants, presets, menus] = await Promise.all([
        db.query('SELECT id FROM variant WHERE is_active IS NOT FALSE'),
        db.query('SELECT DISTINCT variant_id FROM variant_components'),
        db.query('SELECT name, max_flavors FROM menu'),
    ]);
    return {
        activeIds: new Set(variants.rows.map(r => r.id)),
        presetIds: new Set(presets.rows.map(r => r.variant_id)),
        maxFlavors: new Map(menus.rows.map(r => [r.name, Number(r.max_flavors)])),
    };
};

// ---------------------------------------------------------------------------
// Recipe CRUD
// ---------------------------------------------------------------------------

export const getVariantRecipes = async (filter: { store_id: number; variant_id?: number }) => {
    const params: number[] = [filter.store_id];
    let where = 'vr.store_id = $1';
    if (filter.variant_id) {
        params.push(filter.variant_id);
        where += ' AND vr.variant_id = $2';
    }
    const { rows } = await pool.query(`
        SELECT vr.*, s.item_name, s.unit
        FROM variant_recipe vr
        JOIN stock s ON s.id = vr.stock_id
        WHERE ${where}
        ORDER BY vr.variant_id, s.item_name
    `, params);
    return rows;
};

/** Replaces the whole recipe of one variant at one store. */
export const replaceVariantRecipe = async (variant_id: number, store_id: number, lines: unknown) => {
    if (!Number.isInteger(variant_id) || variant_id < 1) throw new ValidationError('variant_id tidak valid');
    if (!Number.isInteger(store_id) || store_id < 1) throw new ValidationError('store_id tidak valid');
    if (!Array.isArray(lines)) throw new ValidationError('items harus berupa array');

    const parsed: RecipeLine[] = lines.map((raw, i) => {
        const line = (raw ?? {}) as Record<string, unknown>;
        const stock_id = Number(line.stock_id);
        const qty_gram = Number(line.qty_gram);
        if (!Number.isInteger(stock_id) || stock_id < 1) throw new ValidationError(`Baris ${i + 1}: stock_id tidak valid`);
        if (!Number.isFinite(qty_gram) || qty_gram <= 0) throw new ValidationError(`Baris ${i + 1}: gram harus > 0`);
        return { stock_id, qty_gram };
    });
    if (new Set(parsed.map(l => l.stock_id)).size !== parsed.length) {
        throw new ValidationError('Bahan yang sama tidak boleh muncul dua kali');
    }

    return transaction(async (client) => {
        const variant = await client.query('SELECT id FROM variant WHERE id = $1', [variant_id]);
        if (variant.rowCount === 0) throw new ValidationError(`Variant ${variant_id} tidak ditemukan`);

        if (parsed.length > 0) {
            const { rows: stocks } = await client.query(
                'SELECT id, item_name, unit, store_id FROM stock WHERE id = ANY($1::int[])',
                [parsed.map(l => l.stock_id)]
            );
            const byId = new Map(stocks.map(s => [s.id, s]));
            for (const line of parsed) {
                const stock = byId.get(line.stock_id);
                if (!stock) throw new ValidationError(`Stock ${line.stock_id} tidak ditemukan`);
                if (stock.store_id !== store_id) throw new ValidationError(`${stock.item_name} bukan stok milik store ini`);
                if (!isGramUnit(stock.unit)) {
                    throw new ValidationError(`${stock.item_name} memakai satuan "${stock.unit}"; resep hanya boleh memakai bahan bersatuan gram`);
                }
            }
        }

        await client.query('DELETE FROM variant_recipe WHERE variant_id = $1 AND store_id = $2', [variant_id, store_id]);
        for (const line of parsed) {
            await client.query(
                'INSERT INTO variant_recipe (variant_id, store_id, stock_id, qty_gram) VALUES ($1, $2, $3, $4)',
                [variant_id, store_id, line.stock_id, line.qty_gram]
            );
        }

        const { rows } = await client.query(`
            SELECT vr.*, s.item_name, s.unit
            FROM variant_recipe vr JOIN stock s ON s.id = vr.stock_id
            WHERE vr.variant_id = $1 AND vr.store_id = $2
            ORDER BY s.item_name
        `, [variant_id, store_id]);
        return rows;
    });
};

export const deleteVariantRecipeLine = async (id: number) => {
    await pool.query('DELETE FROM variant_recipe WHERE id = $1', [id]);
    return true;
};

// ---------------------------------------------------------------------------
// Preset mix components
// ---------------------------------------------------------------------------

export const getVariantComponents = async (variant_id?: number) => {
    const { rows } = variant_id
        ? await pool.query('SELECT * FROM variant_components WHERE variant_id = $1 ORDER BY component_variant_id', [variant_id])
        : await pool.query('SELECT * FROM variant_components ORDER BY variant_id, component_variant_id');
    return rows;
};

/** Replaces the component list of a preset mix. An empty list turns it back into a normal flavor. */
export const replaceVariantComponents = async (variant_id: number, componentIds: unknown) => {
    if (!Number.isInteger(variant_id) || variant_id < 1) throw new ValidationError('variant_id tidak valid');
    if (!Array.isArray(componentIds)) throw new ValidationError('component_ids harus berupa array');

    const ids = [...new Set(componentIds.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id < 1)) throw new ValidationError('component_ids tidak valid');
    if (ids.includes(variant_id)) throw new ValidationError('Variant tidak bisa menjadi komponen dirinya sendiri');

    return transaction(async (client) => {
        if (ids.length > 0) {
            const { rows: found } = await client.query('SELECT id FROM variant WHERE id = ANY($1::int[])', [ids]);
            if (found.length !== ids.length) throw new ValidationError('Sebagian komponen tidak ditemukan');

            // One level only: a component must be a plain flavor, not another preset.
            const { rows: nested } = await client.query(
                'SELECT DISTINCT variant_id FROM variant_components WHERE variant_id = ANY($1::int[])',
                [ids]
            );
            if (nested.length > 0) throw new ValidationError('Komponen tidak boleh berupa paket mix lain');

            // And this variant must not already be used as a component of another preset.
            const { rows: usedAsComponent } = await client.query(
                'SELECT 1 FROM variant_components WHERE component_variant_id = $1 LIMIT 1',
                [variant_id]
            );
            if (usedAsComponent.length > 0) throw new ValidationError('Variant ini dipakai sebagai komponen paket lain');
        }

        await client.query('DELETE FROM variant_components WHERE variant_id = $1', [variant_id]);
        for (const id of ids) {
            await client.query('INSERT INTO variant_components (variant_id, component_variant_id) VALUES ($1, $2)', [variant_id, id]);
        }
        return ids;
    });
};
