import { supabase } from '../config/supabase';

export interface CreateCapitalPayload {
    amount: number;
    note?: string;
}

export interface UpdateCapitalPayload {
    amount?: number;
    note?: string;
}

export const getCapitals = async () => {
    const { data, error } = await supabase
        .from('capital')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
};

export const createCapital = async (payload: CreateCapitalPayload) => {
    const { data, error } = await supabase
        .from('capital')
        .insert([payload])
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const updateCapital = async (id: number, payload: UpdateCapitalPayload) => {
    const { data, error } = await supabase
        .from('capital')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Capital dengan id ${id} tidak ditemukan`);
    return data;
};

export const deleteCapital = async (id: number) => {
    const { error } = await supabase
        .from('capital')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
};
