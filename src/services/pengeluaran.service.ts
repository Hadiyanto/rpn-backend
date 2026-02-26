import { supabase } from '../config/supabase';

export interface CreatePengeluaranPayload {
    name: string;
    category?: string | null;
    price: number;
    date?: string; // ISO date e.g. '2026-02-26'
    receipt_image_url?: string | null;
}

export const createPengeluaran = async (payload: CreatePengeluaranPayload) => {
    const { name, category, price, date, receipt_image_url } = payload;

    const insertData: Record<string, unknown> = { name, price };
    if (category !== undefined) insertData.category = category;
    if (date) insertData.date = date;
    if (receipt_image_url !== undefined) insertData.receipt_image_url = receipt_image_url;

    const { data, error } = await supabase
        .from('pengeluaran')
        .insert(insertData)
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const getPengeluaran = async () => {
    const { data, error } = await supabase
        .from('pengeluaran')
        .select('*')
        .order('date', { ascending: false });

    if (error) throw error;
    return data ?? [];
};
