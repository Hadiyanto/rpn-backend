import { supabase } from '../config/supabase';

export const getStocks = async () => {
    const { data, error } = await supabase
        .from('stock')
        .select('*')
        .order('item_name');

    if (error) throw error;
    return data ?? [];
};
