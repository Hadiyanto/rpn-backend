import { supabase } from '../config/supabase';

export const getMenus = async () => {
  const { data, error } = await supabase
    .from('menu')
    .select('*')
    .order('is_active', { ascending: false })
    .order('id');

  if (error) throw error;
  return data ?? [];
};

export const createMenu = async (name: string, price: number, description?: string, is_active: boolean = true) => {
  const { data, error } = await supabase
    .from('menu')
    .insert([{ name, price, description, is_active }])
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const updateMenu = async (id: number, updates: { name?: string; price?: number; description?: string; is_active?: boolean }) => {
  const { data, error } = await supabase
    .from('menu')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const deleteMenu = async (id: number) => {
  const { error } = await supabase
    .from('menu')
    .delete()
    .eq('id', id);

  if (error) throw error;
  return true;
};
