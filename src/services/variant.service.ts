import { supabase } from '../config/supabase';



export const getVariants = async () => {
    const { data, error } = await supabase
        .from('variant')
        .select('*')
        .order('is_active', { ascending: false })
        .order('id');

    if (error) throw error;
    return data ?? [];
};

export const createVariant = async (variant_name: string, is_active: boolean = true, image_url?: string) => {
    const { data, error } = await supabase
        .from('variant')
        .insert([{ variant_name, is_active, image_url }])
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const updateVariant = async (id: number, updates: { variant_name?: string; is_active?: boolean; image_url?: string }) => {
    const { data, error } = await supabase
        .from('variant')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const deleteVariant = async (id: number) => {
    const { error } = await supabase
        .from('variant')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
};
