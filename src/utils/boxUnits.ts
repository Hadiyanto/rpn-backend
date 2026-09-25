// Quota is counted in "box units": FULL = 1, HALF = 0.5. Retired types (e.g. HAMPERS
// on historical orders) don't consume box quota. Keep the SQL and TS versions in sync.

/** SQL expression over an `order_items` row aliased as `oi`. */
export const BOX_UNITS_SQL = `CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 WHEN oi.box_type = 'FULL' THEN oi.qty ELSE 0 END`;

export const boxUnits = (items: { box_type: string; qty: number }[]): number =>
    items.reduce((sum, item) => {
        if (item.box_type === 'HALF') return sum + item.qty * 0.5;
        if (item.box_type === 'FULL') return sum + item.qty;
        return sum;
    }, 0);

/** Remaining quota never goes below zero, even if an admin lowered qty below what's already sold. */
export const remainingQuota = (qty: number, used: number): number => Math.max(0, qty - used);
