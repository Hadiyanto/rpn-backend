import { supabase } from '../config/supabase';

export const getStores = async () => {
    const { data, error } = await supabase
        .from('stores')
        .select('*')
        .eq('is_active', true)
        .order('id', { ascending: true });

    if (error) throw error;
    return data ?? [];
};

export const getStoreById = async (id: number) => {
    const { data, error } = await supabase
        .from('stores')
        .select('*')
        .eq('id', id)
        .single();

    if (error) throw error;
    return data;
};

export interface UpdateStorePayload {
    name?: string;
    address?: string;
    area_id?: string | null;
    latitude?: number;
    longitude?: number;
    phone?: string | null;
    is_active?: boolean;
    open_time?: string;
}

export const updateStore = async (id: number, payload: UpdateStorePayload) => {
    const { data, error } = await supabase
        .from('stores')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Store dengan id ${id} tidak ditemukan`);
    return data;
};
