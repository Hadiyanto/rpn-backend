import { supabase } from '../config/supabase';

export const getPenjualanByTransaction = async (transactionId: number) => {
    const { data, error } = await supabase
        .from('penjualan')
        .select(`
      *,
      menu ( name ),
      variant ( variant_name )
    `)
        .eq('transaction_id', transactionId);

    if (error) throw error;
    return data ?? [];
};
