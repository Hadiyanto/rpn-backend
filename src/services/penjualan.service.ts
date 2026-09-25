import { pool } from '../config/db';

/**
 * Sales lines of a POS transaction, each with its menu name embedded as `menu: { name }`.
 * `variant` is the stored text column (JSON-encoded toppings) — it has had no FK to the
 * variant table since migration 1770489100000, so it can't be embedded.
 */
export const getPenjualanByTransaction = async (transactionId: number) => {
    const { rows } = await pool.query(`
        SELECT p.*,
               CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object('name', m.name) END AS menu
        FROM penjualan p
        LEFT JOIN menu m ON m.id = p.menu_id
        WHERE p.transaction_id = $1
        ORDER BY p.id
    `, [transactionId]);
    return rows;
};
