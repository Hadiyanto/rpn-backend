import { ValidationError } from '../utils/validation';
import { ConflictError, NotFoundError } from '../utils/errors';
import { DEFAULT_BOX_RULES, boxRule, isBoxType, type BoxType } from '../utils/boxRules';
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

/** Menu rows keyed by box type (FULL/HALF), including shipping size/weight. */
export const getMenuBoxMap = async (): Promise<Map<string, any>> => {
  const { rows } = await pool.query('SELECT * FROM menu ORDER BY is_active DESC NULLS LAST, id');
  const map = new Map<string, any>();
  for (const row of rows) if (!map.has(row.name)) map.set(row.name, row);
  return map;
};

/** Biteship item fields for one box: value = menu price, size/weight from the menu row (rule defaults as fallback). */
export const boxShippingItem = (menu: any | undefined, boxType: string) => {
  const rule = boxRule(boxType);
  return {
    value: Number(menu?.price ?? 0),
    length: menu?.length_cm ?? rule?.length_cm ?? 10,
    width: menu?.width_cm ?? rule?.width_cm ?? 10,
    height: menu?.height_cm ?? rule?.height_cm ?? 10,
    weight: menu?.weight_gram ?? rule?.weight_gram ?? 500,
  };
};

/** Biteship items for [{ box_type, qty }] using each box's price, size and weight from the menu table. */
export const buildShippingItems = async (boxes: unknown) => {
  if (!Array.isArray(boxes)) return [];
  const menus = await getMenuBoxMap();
  return boxes
    .filter((b: any) => Number(b?.qty) > 0)
    .map((b: any) => {
      const boxType = String(b.box_type);
      const label = boxType === 'FULL' ? 'Full Box' : boxType === 'HALF' ? 'Half Box' : boxType;
      return { name: label, description: `RPN ${boxType}`, ...boxShippingItem(menus.get(boxType), boxType), quantity: Number(b.qty) };
    });
};

const toPositiveInt = (value: unknown, field: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${field} harus bilangan bulat > 0`);
  return n;
};

export interface MenuInput {
  name?: string;
  price?: number;
  description?: string;
  is_active?: boolean;
  store_ids?: number[];
  box_multiplier?: number;
  max_flavors?: number;
  weight_gram?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
}

/** Validates the editable fields against the box type's rules. Returns only the fields that were given. */
const validateMenuFields = (boxType: BoxType, input: MenuInput) => {
  const rule = DEFAULT_BOX_RULES[boxType];
  const out: Record<string, unknown> = {};

  if (input.price !== undefined) {
    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0) throw new ValidationError('Harga tidak valid');
    out.price = price;
  }
  if (input.description !== undefined) out.description = input.description;
  if (input.is_active !== undefined) out.is_active = !!input.is_active;
  if (input.store_ids !== undefined) {
    if (!Array.isArray(input.store_ids) || input.store_ids.some(id => !Number.isInteger(Number(id)))) {
      throw new ValidationError('store_ids tidak valid');
    }
    out.store_ids = input.store_ids.map(Number);
  }
  if (input.box_multiplier !== undefined) {
    const m = Number(input.box_multiplier);
    if (!Number.isFinite(m) || m <= 0 || m > 10) throw new ValidationError('Porsi resep harus > 0');
    out.box_multiplier = m;
  }
  if (input.max_flavors !== undefined) {
    const f = Number(input.max_flavors);
    if (!Number.isInteger(f) || f < 1 || f > rule.max_flavors_limit) {
      throw new ValidationError(`Maks rasa untuk box ${boxType} harus 1–${rule.max_flavors_limit}`);
    }
    out.max_flavors = f;
  }
  for (const field of ['weight_gram', 'length_cm', 'width_cm', 'height_cm'] as const) {
    if (input[field] !== undefined) out[field] = toPositiveInt(input[field], field);
  }
  return out;
};

/** Creates the FULL or HALF box, filling product-rule defaults for anything not given. */
export const createMenu = async (input: MenuInput) => {
  if (!isBoxType(input.name)) throw new ValidationError('Jenis box harus FULL atau HALF');
  const boxType = input.name;
  const { rows: existing } = await pool.query('SELECT 1 FROM menu WHERE name = $1', [boxType]);
  if (existing.length > 0) throw new ConflictError(`Box ${boxType} sudah ada`);
  if (input.price === undefined) throw new ValidationError('Harga wajib diisi');

  const rule = DEFAULT_BOX_RULES[boxType];
  return insertRow('menu', {
    name: boxType,
    max_flavors: rule.max_flavors,
    box_multiplier: rule.box_multiplier,
    weight_gram: rule.weight_gram,
    length_cm: rule.length_cm,
    width_cm: rule.width_cm,
    height_cm: rule.height_cm,
    ...validateMenuFields(boxType, input),
  });
};

/** Box type (name) is fixed after creation; everything else is validated against its rules. */
export const updateMenu = async (id: number, updates: MenuInput) => {
  const { rows: [current] } = await pool.query('SELECT name FROM menu WHERE id = $1', [id]);
  if (!current) throw new NotFoundError(`Menu dengan id ${id} tidak ditemukan`);
  if (updates.name !== undefined && updates.name !== current.name) {
    throw new ValidationError('Jenis box tidak bisa diubah; hapus lalu buat box baru');
  }
  if (!isBoxType(current.name)) throw new ValidationError(`Box ${current.name} sudah tidak didukung`);

  const data = await updateRowById('menu', id, validateMenuFields(current.name, updates));
  if (!data) throw new NotFoundError(`Menu dengan id ${id} tidak ditemukan`);
  return data;
};

export const deleteMenu = async (id: number) => {
  const { rowCount } = await pool.query('DELETE FROM menu WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError(`Menu dengan id ${id} tidak ditemukan`);
  return true;
};
