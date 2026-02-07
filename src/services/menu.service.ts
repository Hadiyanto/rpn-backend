import { supabase } from '../config/supabase';

export const getMenus = async () => {
  const { data, error } = await supabase
    .from('menu')
    .select('*')
    .eq('is_active', true)
    .order('id');

  if (error) throw error;
  return data ?? [];
};
