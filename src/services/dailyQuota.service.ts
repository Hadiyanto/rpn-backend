import { supabase } from '../config/supabase';

export const getDailyQuotas = async () => {
    const { data, error } = await supabase
        .from('daily_quota')
        .select('*')
        .order('date', { ascending: false });

    if (error) throw error;
    return data ?? [];
};

export const getDailyQuotaByDate = async (date: string) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .select('*')
        .eq('date', date)
        .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 is not found
    return data;
};

export const createDailyQuota = async (date: string, qty: number) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .insert([{ date, qty }])
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const updateDailyQuota = async (id: number, qty: number) => {
    const { data, error } = await supabase
        .from('daily_quota')
        .update({ qty, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const deleteDailyQuota = async (id: number) => {
    const { error } = await supabase
        .from('daily_quota')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
};
