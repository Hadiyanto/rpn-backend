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
    qty_change: number; // positive or negative
    type: 'IN' | 'OUT' | 'ADJUSTMENT';
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

    const final_qty = Number(stock.qty) + Number(payload.qty_change);

    // 2. Insert into history
    const { error: histErr } = await supabase.from('stock_history').insert({
        stock_id: payload.stock_id,
        type: payload.type,
        qty_change: payload.qty_change,
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
