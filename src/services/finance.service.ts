import { pool } from '../config/db';
import { getMenuPriceMap } from './menu.service';

export const getWeeklySummary = async (start: string, end: string) => {
    // 1. Items of DONE orders in range, grouped per box type
    const { rows: itemRows } = await pool.query(`
        SELECT oi.box_type, SUM(oi.qty)::int AS qty
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status = 'DONE'
          AND o.pickup_date >= $1::date
          AND o.pickup_date <= $2::date
        GROUP BY oi.box_type
    `, [start, end]);

    // Prices come from the menu table (including retired menus such as HAMPERS, so older
    // orders are still counted) instead of being hardcoded here.
    const prices = await getMenuPriceMap({ activeOnly: false });

    let totalRevenue = 0;
    let totalBoxes = 0;
    for (const row of itemRows) {
        totalRevenue += row.qty * (prices.get(row.box_type) ?? 0);
        totalBoxes += row.qty;
    }

    // 2–4. Expenses in range, personal capital, remaining ACTIVE debt
    const [{ rows: [cost] }, { rows: [capital] }, { rows: [debt] }] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(price), 0) AS total FROM pengeluaran WHERE date >= $1::date AND date <= $2::date', [start, end]),
        pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM capital'),
        pool.query(`SELECT COALESCE(SUM(remaining_amount), 0) AS total FROM debt WHERE status = 'ACTIVE'`),
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
    };
};
