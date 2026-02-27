import { supabase } from '../config/supabase';

export interface CreateDebtPayload {
    source: string;
    total_amount: number;
    remaining_amount: number;
    status?: 'ACTIVE' | 'PAID';
}

export interface UpdateDebtPayload {
    source?: string;
    total_amount?: number;
    remaining_amount?: number;
    status?: 'ACTIVE' | 'PAID';
}

export const getDebts = async () => {
    const { data, error } = await supabase
        .from('debt')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
};

export const createDebt = async (payload: CreateDebtPayload) => {
    const { data, error } = await supabase
        .from('debt')
        .insert([{
            ...payload,
            status: payload.status ?? 'ACTIVE',
        }])
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const updateDebt = async (id: number, payload: UpdateDebtPayload) => {
    const { data, error } = await supabase
        .from('debt')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Debt dengan id ${id} tidak ditemukan`);
    return data;
};

export const deleteDebt = async (id: number) => {
    const { error } = await supabase
        .from('debt')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
};
