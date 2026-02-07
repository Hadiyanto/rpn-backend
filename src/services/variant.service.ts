import { supabase } from '../config/supabase';

export const getVariantsByMenu = async (menuId: number) => {
    const { data, error } = await supabase
        .from('variant')
        .select('*')
        .eq('menu_id', menuId)
        .eq('is_active', true)
        .order('id');

    if (error) throw error;
    return data ?? [];
};

export const getVariants = async () => {
    const { data, error } = await supabase
        .from('variant')
        .select('*')
        .eq('is_active', true)
        .order('id');

    if (error) throw error;
    return data ?? [];
};
