import { pool } from '../config/db';
import { getMenuPriceMap } from './menu.service';

/**
 * Summary for a date range, for one store or (storeId undefined) the whole business.
 * Per store: revenue and expenses of that store only; general expenses (store_id NULL) are shown
 * separately and only counted in the whole-business view. Capital and debt are business-wide.
 */
export const getWeeklySummary = async (start: string, end: string, storeId?: number) => {
    const store = storeId ?? null;
    // 1. Items of DONE orders in range, grouped per box type
    const { rows: itemRows } = await pool.query(`
        SELECT oi.box_type, SUM(oi.qty)::int AS qty, SUM(oi.qty * oi.unit_price) AS revenue
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status = 'DONE'
          AND o.pickup_date >= $1::date
          AND o.pickup_date <= $2::date
          AND ($3::int IS NULL OR o.store_id = $3)
        GROUP BY oi.box_type
    `, [start, end, store]);

    // Prices come from the menu table (including retired menus such as HAMPERS, so older
    // orders are still counted) instead of being hardcoded here.
    const prices = await getMenuPriceMap({ activeOnly: false });

    let totalRevenue = 0;
    let totalBoxes = 0;
    for (const row of itemRows) {
        // unit_price is snapshotted per box; the menu price only covers rows from before that existed.
        totalRevenue += row.revenue ?? row.qty * (prices.get(row.box_type) ?? 0);
        totalBoxes += row.qty;
    }

    // 2–4. Expenses in range, personal capital, remaining ACTIVE debt
    const [{ rows: [cost] }, { rows: [capital] }, { rows: [debt] }, { rows: [stockCost] }] = await Promise.all([
        pool.query(`
            SELECT COALESCE(SUM(price) FILTER (WHERE $3::int IS NULL OR store_id = $3), 0) AS total,
                   COALESCE(SUM(price) FILTER (WHERE store_id IS NULL), 0) AS general,
                   COALESCE(SUM(price) FILTER (WHERE category = 'Gaji' AND ($3::int IS NULL OR store_id = $3)), 0) AS salary
            FROM pengeluaran WHERE date >= $1::date AND date <= $2::date
        `, [start, end, store]),
        pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM capital'),
        pool.query(`SELECT COALESCE(SUM(remaining_amount), 0) AS total FROM debt WHERE status = 'ACTIVE'`),
        // Info only (not added to costs): ingredient + packaging cost booked by those orders.
        // Purchases are usually recorded as expenses already, so adding it would count twice.
        pool.query(`
            SELECT COALESCE(SUM(-sh.qty_change * sh.unit_cost), 0) AS total
            FROM stock_history sh JOIN orders o ON o.id = sh.order_id
            WHERE o.status = 'DONE' AND o.pickup_date >= $1::date AND o.pickup_date <= $2::date
              AND ($3::int IS NULL OR o.store_id = $3)
        `, [start, end, store]),
    ]);
    const totalCost = Number(cost.total);
    const personalCapital = Number(capital.total);
    const remainingDebt = Number(debt.total);

    // 5. Calculations
    const grossProfit = totalRevenue - totalCost;
    const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    // Logic modal putar bisa ditambahkan di sini
    const withdrawableProfit = grossProfit;

    const netMarginReal = totalRevenue > 0 ? (withdrawableProfit / totalRevenue) * 100 : 0;
    const profitPerBoxReal = totalBoxes > 0 ? withdrawableProfit / totalBoxes : 0;

    const returnToCapital = personalCapital > 0 ? (withdrawableProfit / personalCapital) * 100 : 0;

    return {
        totalRevenue,
        totalCost,
        grossProfit,
        grossMargin: Number(grossMargin.toFixed(2)),
        withdrawableProfit,
        netMarginReal: Number(netMarginReal.toFixed(2)),
        profitPerBoxReal: Math.round(profitPerBoxReal),
        returnToCapital: Number(returnToCapital.toFixed(2)),
        totalBoxes,
        remainingDebt,
        storeId: store,
        /** Expenses without a store; included in totalCost only for the whole-business view. */
        generalCost: Number(cost.general),
        salaryCost: Number(cost.salary),
        stockCostSold: Math.round(Number(stockCost.total)),
    };
};
