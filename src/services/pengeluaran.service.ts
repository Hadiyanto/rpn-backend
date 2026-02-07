import { supabase } from '../config/supabase';

export const getPengeluaran = async () => {
    const { data, error } = await supabase
        .from('pengeluaran')
        .select('*')
        .order('date', { ascending: false });

    if (error) throw error;
    return data ?? [];
};
