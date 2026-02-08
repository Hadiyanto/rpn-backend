import { supabase } from '../config/supabase';



export const getVariants = async () => {
    const { data, error } = await supabase
        .from('variant')
        .select('*')
        .eq('is_active', true)
        .order('id');

    if (error) throw error;
    return data ?? [];
};
