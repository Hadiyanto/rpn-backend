import { supabase } from '../config/supabase';

export const getWeeklySummary = async (start: string, end: string) => {
    // 1. Get DONE orders in range
    const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select(`
            id,
            status,
            pickup_date,
            items:order_items (
                qty,
                box_type
            )
        `)
        .eq('status', 'DONE')
        .gte('pickup_date', start)
        .lte('pickup_date', end);

    if (ordersError) throw ordersError;

    const PRICE = {
        FULL: 65000,
        HALF: 35000,
    };

    let totalRevenue = 0;
    let totalBoxes = 0;

    (orders ?? []).forEach((order: any) => {
        (order.items ?? []).forEach((item: any) => {
            const boxType = item.box_type as 'FULL' | 'HALF';
            totalRevenue += item.qty * (PRICE[boxType] || 0);
            totalBoxes += item.qty;
        });
    });

    // 2. Get total expenses in range
    const { data: expenses, error: expensesError } = await supabase
        .from('pengeluaran')
        .select('price')
        .gte('date', start)
        .lte('date', end);

    if (expensesError) throw expensesError;

    const totalCost = (expenses ?? []).reduce((sum, exp: any) => sum + Number(exp.price), 0);

    // 3. Get personal capital (sum)
    const { data: capitals, error: capitalError } = await supabase
        .from('capital')
        .select('amount');

    if (capitalError) throw capitalError;

    const personalCapital = (capitals ?? []).reduce((sum, cap: any) => sum + Number(cap.amount), 0);

    // 4. Get remaining debt (ACTIVE only)
    const { data: debts, error: debtError } = await supabase
        .from('debt')
        .select('remaining_amount')
        .eq('status', 'ACTIVE');

    if (debtError) throw debtError;

    const remainingDebt = (debts ?? []).reduce((sum, d: any) => sum + Number(d.remaining_amount), 0);

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
