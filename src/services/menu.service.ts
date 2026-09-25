import { ValidationError } from '../utils/validation';
import { NotFoundError } from '../utils/errors';
import { pool, insertRow, updateRowById } from '../config/db';

export const getMenus = async () => {
  const { rows } = await pool.query('SELECT * FROM menu ORDER BY is_active DESC, id');
  return rows;
};

/**
 * Price per box type from the menu table. `activeOnly: false` also includes retired menus
 * (e.g. HAMPERS) so historical revenue can still be priced.
 */
export const getMenuPriceMap = async ({ activeOnly = true } = {}): Promise<Map<string, number>> => {
  const { rows } = await pool.query(
    `SELECT name, price FROM menu ${activeOnly ? 'WHERE is_active IS NOT FALSE' : ''} ORDER BY is_active DESC NULLS LAST, id`
  );
  const prices = new Map<string, number>();
  for (const row of rows) {
    if (!prices.has(row.name)) prices.set(row.name, Number(row.price));
  }
  return prices;
};

export const createMenu = async (name: string, price: number, description?: string, is_active: boolean = true) =>
  insertRow('menu', { name, price, description, is_active });

export interface MenuUpdates {
  name?: string;
  price?: number;
  description?: string;
  is_active?: boolean;
  store_ids?: number[];
  box_multiplier?: number;
  max_flavors?: number;
}

export const updateMenu = async (id: number, updates: MenuUpdates) => {
  if (updates.box_multiplier !== undefined) {
    const m = Number(updates.box_multiplier);
    if (!Number.isFinite(m) || m <= 0 || m > 10) throw new ValidationError('box_multiplier harus > 0');
    updates.box_multiplier = m;
  }
  if (updates.max_flavors !== undefined) {
    const f = Number(updates.max_flavors);
    if (!Number.isInteger(f) || f < 1 || f > 10) throw new ValidationError('max_flavors harus bilangan bulat 1–10');
    updates.max_flavors = f;
  }

  const data = await updateRowById('menu', id, {
    name: updates.name,
    price: updates.price,
    description: updates.description,
    is_active: updates.is_active,
    store_ids: updates.store_ids,
    box_multiplier: updates.box_multiplier,
    max_flavors: updates.max_flavors,
  });
  if (!data) throw new NotFoundError(`Menu dengan id ${id} tidak ditemukan`);
  return data;
};

export const deleteMenu = async (id: number) => {
  await pool.query('DELETE FROM menu WHERE id = $1', [id]);
  return true;
};
