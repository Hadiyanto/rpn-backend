import { pool } from '../config/db';
import { BOX_TYPES } from '../utils/boxRules';
import { todayWIB } from '../utils/date';

export type SetupState = 'done' | 'partial' | 'todo';

export interface SetupStep {
    key: string;
    title: string;
    state: SetupState;
    detail: string;
    /** Frontend page where this step is done. */
    href: string;
}

const state = (ok: boolean, some = false): SetupState => (ok ? 'done' : some ? 'partial' : 'todo');

/** Checklist of everything a store needs before it can take orders (see docs/plan-setup-dari-nol.md). */
export const getSetupStatus = async (storeId: number): Promise<SetupStep[]> => {
    const today = todayWIB();
    const [menus, variants, stocks, quota, hourly, salary, store] = await Promise.all([
        pool.query('SELECT name, price, is_active, $1 = ANY(store_ids) AS in_store FROM menu', [storeId]),
        pool.query(`
            SELECT v.id, v.variant_name,
                   EXISTS (SELECT 1 FROM variant_recipe vr WHERE vr.variant_id = v.id AND vr.store_id = $1) AS has_recipe
            FROM variant v
            WHERE v.is_active IS NOT FALSE AND $1 = ANY(v.store_ids)
        `, [storeId]),
        pool.query(`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE lower(trim(unit)) IN ('gram','g','gr'))::int AS gram,
                   count(*) FILTER (WHERE lower(trim(unit)) IN ('gram','g','gr') AND price_per_unit IS NULL)::int AS gram_without_price
            FROM stock WHERE store_id = $1
        `, [storeId]),
        pool.query(`SELECT count(*)::int AS n FROM daily_quota WHERE store_id = $1 AND date >= $2::date AND date < $2::date + 14`, [storeId, today]),
        pool.query(`SELECT count(*)::int AS n FROM hourly_quota WHERE store_id = $1 AND is_active`, [storeId]),
        pool.query(`SELECT count(*)::int AS n FROM salary_config`),
        pool.query(`SELECT * FROM stores WHERE id = $1`, [storeId]),
    ]);

    const menuByName = new Map(menus.rows.map(m => [m.name, m]));
    const boxesReady = BOX_TYPES.filter(b => {
        const m = menuByName.get(b);
        return m && m.is_active !== false && m.in_store && Number(m.price) > 0;
    });
    const activeVariants = variants.rows;
    const withoutRecipe = activeVariants.filter(v => !v.has_recipe);
    const s = stocks.rows[0];
    const st = store.rows[0] ?? {};

    return [
        {
            key: 'menu',
            title: 'Menu box (FULL & HALF)',
            state: state(boxesReady.length === BOX_TYPES.length, boxesReady.length > 0),
            detail: BOX_TYPES.map(b => `${b} ${boxesReady.includes(b) ? '✓' : '✗'}`).join(' · '),
            href: '/config?tab=menu',
        },
        {
            key: 'variants',
            title: 'Varian rasa',
            state: state(activeVariants.length > 0),
            detail: `${activeVariants.length} rasa aktif di store ini`,
            href: '/config?tab=varian',
        },
        {
            key: 'stock',
            title: 'Bahan baku (gram)',
            state: state(s.gram > 0 && s.gram_without_price === 0, s.gram > 0),
            detail: `${s.gram} bahan gram${s.gram_without_price ? `, ${s.gram_without_price} belum ada harga beli` : ''}`,
            href: '/stock',
        },
        {
            key: 'recipes',
            title: 'Resep tiap rasa',
            state: state(activeVariants.length > 0 && withoutRecipe.length === 0, activeVariants.length > withoutRecipe.length),
            detail: withoutRecipe.length === 0
                ? (activeVariants.length ? 'Semua rasa punya resep' : 'Belum ada rasa')
                : `Belum ada resep: ${withoutRecipe.slice(0, 5).map(v => v.variant_name).join(', ')}${withoutRecipe.length > 5 ? ` +${withoutRecipe.length - 5}` : ''}`,
            href: '/config?tab=varian',
        },
        {
            key: 'quota',
            title: 'Kuota harian (14 hari ke depan)',
            state: state(quota.rows[0].n >= 7, quota.rows[0].n > 0),
            detail: `${quota.rows[0].n} tanggal dibuka`,
            href: '/config?tab=kuota',
        },
        {
            key: 'hourly',
            title: 'Kuota per jam',
            state: state(hourly.rows[0].n > 0),
            detail: `${hourly.rows[0].n} slot jam aktif`,
            href: '/config?tab=kuota',
        },
        {
            key: 'store',
            title: 'Data store (alamat, rekening, QRIS)',
            state: state(!!(st.address && st.phone && st.bank_account_number && st.latitude && st.area_id), !!st.address),
            detail: [
                st.address ? 'alamat ✓' : 'alamat ✗',
                st.bank_account_number ? 'rekening ✓' : 'rekening ✗',
                st.qris_image_url ? 'QRIS ✓' : 'QRIS ✗',
                st.area_id && st.latitude ? 'lokasi ✓' : 'lokasi ✗',
            ].join(' · '),
            href: '/config?tab=store',
        },
        {
            key: 'salary',
            title: 'Konfigurasi gaji',
            state: state(salary.rows[0].n > 0),
            detail: `${salary.rows[0].n} aturan`,
            href: '/config/salary',
        },
    ];
};
