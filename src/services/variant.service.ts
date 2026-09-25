import { pool, insertRow, updateRowById } from '../config/db';
import { NotFoundError } from '../utils/errors';

/** All variants, each with `component_ids` (non-empty only for preset mixes like "Mix 3"). */
export const getVariants = async () => {
    const { rows } = await pool.query(`
        SELECT v.*,
               COALESCE(
                   array_agg(vc.component_variant_id ORDER BY vc.component_variant_id)
                       FILTER (WHERE vc.component_variant_id IS NOT NULL),
                   '{}'
               ) AS component_ids
        FROM variant v
        LEFT JOIN variant_components vc ON vc.variant_id = v.id
        GROUP BY v.id
        ORDER BY v.is_active DESC, v.id
    `);
    return rows;
};

export const createVariant = async (variant_name: string, is_active: boolean = true, image_url?: string) =>
    insertRow('variant', { variant_name, is_active, image_url });

export const updateVariant = async (id: number, updates: { variant_name?: string; is_active?: boolean; image_url?: string; store_ids?: number[] }) => {
    const data = await updateRowById('variant', id, {
        variant_name: updates.variant_name,
        is_active: updates.is_active,
        image_url: updates.image_url,
        store_ids: updates.store_ids,
    });
    if (!data) throw new NotFoundError(`Variant dengan id ${id} tidak ditemukan`);
    return data;
};

export const deleteVariant = async (id: number) => {
    await pool.query('DELETE FROM variant WHERE id = $1', [id]);
    return true;
};
