import type { PoolClient } from 'pg';
import { pool, transaction } from '../config/db';
import { BOX_UNITS_SQL } from '../utils/boxUnits';
import { ValidationError } from '../utils/validation';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Daily salary per store (docs/plan-gaji.md): a fixed base that covers the first boxes, then a
 * bonus per box in tiers. Boxes are box units (HALF = 0.5) of PAID/DONE orders, rounded up.
 * Example with 0–15 = 150.000 fixed, 16–20 = 5.000, 21–25 = 6.000, 26–30 = 7.000:
 *   20 boxes → 150.000 + 5 × 5.000 = 175.000;  30 → 240.000;  35 → 240.000 (no tier above 30).
 */
export interface SalaryTier {
    min_box: number;
    max_box: number | null;
    amount: number;
    is_fixed: boolean;
}

export interface SalaryLine {
    from: number;
    to: number;
    boxes: number;
    rate: number;
    fixed: boolean;
    amount: number;
}

export interface SalaryResult {
    total: number;
    lines: SalaryLine[];
}

/** Pure: salary for `boxes` (already rounded) under `tiers`. */
export const computeSalary = (tiers: SalaryTier[], boxes: number): SalaryResult => {
    const lines: SalaryLine[] = [];
    for (const tier of [...tiers].sort((a, b) => a.min_box - b.min_box)) {
        if (boxes < tier.min_box) continue;
        const to = tier.max_box === null ? boxes : Math.min(boxes, tier.max_box);
        // A fixed tier (base salary) counts from box 1 even when it starts at 0.
        const from = Math.max(tier.min_box, tier.is_fixed ? 1 : tier.min_box);
        const count = Math.max(0, to - from + 1);
        if (tier.is_fixed) {
            lines.push({ from, to: tier.max_box ?? to, boxes: count, rate: Number(tier.amount), fixed: true, amount: Number(tier.amount) });
        } else if (count > 0) {
            lines.push({ from, to, boxes: count, rate: Number(tier.amount), fixed: false, amount: count * Number(tier.amount) });
        }
    }
    return { total: lines.reduce((sum, l) => sum + l.amount, 0), lines };
};

/** Tiers must start with the base salary and follow each other without gaps or overlaps. */
export const validateTiers = (raw: unknown): SalaryTier[] => {
    if (!Array.isArray(raw)) throw new ValidationError('Konfigurasi gaji harus berupa array');
    const tiers = raw.map((r, i) => {
        const t = (r ?? {}) as Record<string, unknown>;
        const min_box = Number(t.min_box);
        const max_box = t.max_box === null || t.max_box === undefined || t.max_box === '' ? null : Number(t.max_box);
        const amount = Number(t.amount);
        const label = `Tingkat ${i + 1}`;
        if (!Number.isInteger(min_box) || min_box < 0) throw new ValidationError(`${label}: box awal tidak valid`);
        if (max_box !== null && (!Number.isInteger(max_box) || max_box < min_box)) throw new ValidationError(`${label}: box akhir harus ≥ box awal`);
        if (!Number.isFinite(amount) || amount < 0) throw new ValidationError(`${label}: nominal tidak valid`);
        return { min_box, max_box, amount, is_fixed: t.is_fixed === true };
    }).sort((a, b) => a.min_box - b.min_box);

    tiers.forEach((t, i) => {
        if (i > 0) {
            const prev = tiers[i - 1];
            if (prev.max_box === null) throw new ValidationError('Hanya tingkat terakhir yang boleh tanpa batas atas');
            if (t.min_box !== prev.max_box + 1) {
                throw new ValidationError(`Tingkat box ${t.min_box} harus mulai tepat setelah box ${prev.max_box} (tanpa celah atau tumpang tindih)`);
            }
            if (t.is_fixed) throw new ValidationError('Hanya tingkat pertama (gaji pokok) yang boleh bernilai tetap');
        }
    });
    return tiers;
};

const assertStore = (storeId: number) => {
    if (!Number.isInteger(storeId) || storeId < 1) throw new ValidationError('store_id wajib diisi');
};

export const getSalaryConfig = async (storeId: number, db: Queryable = pool) => {
    assertStore(storeId);
    const { rows } = await db.query('SELECT * FROM salary_config WHERE store_id = $1 ORDER BY min_box ASC', [storeId]);
    return rows;
};

const loadTiers = async (storeId: number, db: Queryable = pool): Promise<SalaryTier[]> =>
    (await getSalaryConfig(storeId, db)).map(r => ({
        min_box: r.min_box, max_box: r.max_box, amount: Number(r.amount), is_fixed: r.is_fixed,
    }));

/** Replaces a store's tiers in one transaction, so a failed insert can't leave it empty. */
export const updateSalaryConfig = async (storeId: number, raw: unknown) => {
    assertStore(storeId);
    const tiers = validateTiers(raw);
    return transaction(async (client) => {
        await client.query('DELETE FROM salary_config WHERE store_id = $1', [storeId]);
        for (const t of tiers) {
            await client.query(
                'INSERT INTO salary_config (store_id, min_box, max_box, amount, is_fixed) VALUES ($1, $2, $3, $4, $5)',
                [storeId, t.min_box, t.max_box, t.amount, t.is_fixed]
            );
        }
        return getSalaryConfig(storeId, client);
    });
};

export const copySalaryConfig = async (fromStoreId: number, toStoreId: number) => {
    assertStore(fromStoreId);
    assertStore(toStoreId);
    if (fromStoreId === toStoreId) throw new ValidationError('Store asal dan tujuan tidak boleh sama');
    const tiers = await loadTiers(fromStoreId);
    if (tiers.length === 0) throw new ValidationError('Store asal belum punya konfigurasi gaji');
    return updateSalaryConfig(toStoreId, tiers);
};

export const getDailySalaries = async (storeId?: number) => {
    const { rows } = storeId
        ? await pool.query('SELECT * FROM daily_salary WHERE store_id = $1 ORDER BY date DESC', [storeId])
        : await pool.query('SELECT * FROM daily_salary ORDER BY date DESC, store_id');
    return rows;
};

export const calculateSalaryPreview = async (date: string, storeId: number, db: Queryable = pool) => {
    assertStore(storeId);
    const { rows: [sum] } = await db.query(`
        SELECT COALESCE(SUM(${BOX_UNITS_SQL}), 0) AS total_boxes
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.pickup_date = $1::date
          AND o.store_id = $2
          AND o.status IN ('PAID', 'DONE')
    `, [date, storeId]);
    const totalBoxes = Number(sum.total_boxes);
    const boxCountInt = Math.ceil(totalBoxes);
    const result = computeSalary(await loadTiers(storeId, db), boxCountInt);

    return {
        date,
        store_id: storeId,
        totalBoxesRaw: totalBoxes,
        totalBoxesRounded: boxCountInt,
        totalSalary: result.total,
        breakdown: result.lines,
    };
};

/**
 * Saves the day's salary for a store and books it as that store's expense ("Gaji"), linked by
 * daily_salary_id, so regenerating updates the same expense instead of adding another.
 */
export const generateDailySalary = async (date: string, storeId: number) =>
    transaction(async (client) => {
        const preview = await calculateSalaryPreview(date, storeId, client);
        const { rows: [saved] } = await client.query(`
            INSERT INTO daily_salary (date, store_id, total_boxes, total_salary, breakdown, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (date, store_id) DO UPDATE
            SET total_boxes = EXCLUDED.total_boxes, total_salary = EXCLUDED.total_salary,
                breakdown = EXCLUDED.breakdown, updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [date, storeId, preview.totalBoxesRounded, preview.totalSalary, JSON.stringify(preview.breakdown)]);

        const { rows: [store] } = await client.query('SELECT name FROM stores WHERE id = $1', [storeId]);
        if (preview.totalSalary > 0) {
            await client.query(`
                INSERT INTO pengeluaran (name, category, price, date, store_id, daily_salary_id)
                VALUES ($1, 'Gaji', $2, $3, $4, $5)
                ON CONFLICT (daily_salary_id) DO UPDATE
                SET name = EXCLUDED.name, price = EXCLUDED.price, date = EXCLUDED.date, store_id = EXCLUDED.store_id
            `, [`Gaji harian ${store?.name ?? `store ${storeId}`} ${date}`, preview.totalSalary, date, storeId, saved.id]);
        } else {
            await client.query('DELETE FROM pengeluaran WHERE daily_salary_id = $1', [saved.id]);
        }
        return saved;
    });

// ---------------------------------------------------------------------------
// Labor cost per box for HPP
// ---------------------------------------------------------------------------

export interface LaborCost {
    /** Salary per FULL box (box units); a HALF box costs this × its box_multiplier. */
    per_box: number;
    target_boxes: number;
    reference_store_id: number;
    reference_store_name: string | null;
}

/**
 * salary(target) / target of the store, or of its labor reference store (labor_reference_store_id).
 * Estimate only: the real cost per box depends on how many boxes were sold that day.
 */
export const getLaborCost = async (storeId: number, db: Queryable = pool): Promise<LaborCost | null> => {
    const { rows: [store] } = await db.query(`
        SELECT COALESCE(r.id, s.id) AS ref_id, COALESCE(r.name, s.name) AS ref_name,
               COALESCE(r.labor_target_boxes, s.labor_target_boxes) AS target
        FROM stores s LEFT JOIN stores r ON r.id = s.labor_reference_store_id
        WHERE s.id = $1
    `, [storeId]);
    if (!store) return null;
    const target = Number(store.target) || 30;
    const { total } = computeSalary(await loadTiers(store.ref_id, db), target);
    return {
        per_box: Math.round((total / target) * 100) / 100,
        target_boxes: target,
        reference_store_id: store.ref_id,
        reference_store_name: store.ref_name,
    };
};
