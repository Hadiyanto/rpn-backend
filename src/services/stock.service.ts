import { supabase } from '../config/supabase';

export const getStocks = async () => {
    const { data, error } = await supabase
        .from('stock')
        .select('*')
        .order('item_name');

    if (error) throw error;
    return data ?? [];
};

export interface AdjustStockDTO {
    stock_id: number;
    qty_change: number; // For addition: the amount to add. For target: the final desired quantity.
    type: 'IN' | 'OUT' | 'ADJUSTMENT';
    is_target?: boolean; // If true, qty_change is treated as the final physical count
    notes?: string;
}

export const adjustStock = async (payload: AdjustStockDTO) => {
    // 1. Get current stock
    const { data: stock, error: stockErr } = await supabase
        .from('stock')
        .select('qty')
        .eq('id', payload.stock_id)
        .single();

    if (stockErr) throw stockErr;

    let final_qty = 0;
    let history_qty_change = 0;

    if (payload.is_target) {
        // Physical count mode: input is the TARGET quantity
        final_qty = Number(payload.qty_change);
        // Formula per user request: stock - input as the "loss" or change magnitude
        // Actually, we store delta = target - current for consistency in history lists
        history_qty_change = final_qty - Number(stock.qty);
    } else {
        // Addition mode: input is the DELTA
        final_qty = Number(stock.qty) + Number(payload.qty_change);
        history_qty_change = Number(payload.qty_change);
    }

    // 2. Insert into history
    const { error: histErr } = await supabase.from('stock_history').insert({
        stock_id: payload.stock_id,
        type: payload.type,
        qty_change: history_qty_change,
        final_qty,
        notes: payload.notes
    });

    if (histErr) throw histErr;

    // 3. Update main stock table
    const { data: updatedStock, error: updateErr } = await supabase
        .from('stock')
        .update({ qty: final_qty })
        .eq('id', payload.stock_id)
        .select()
        .single();

    if (updateErr) throw updateErr;

    return updatedStock;
};

export const getStockHistory = async (stockId: number) => {
    const { data, error } = await supabase
        .from('stock_history')
        .select('*')
        .eq('stock_id', stockId)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
};
