import { supabase } from '../config/supabase';

export const getTransactions = async () => {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .order('date', { ascending: false });

    if (error) throw error;
    return data ?? [];
};

export const createTransaction = async (items: any[], total_price_checkout: number, customer_name: string) => {

    // 1. Generate Order Number
    const { data: lastOrder } = await supabase
        .from('transactions')
        .select('order_number')
        .order('id', { ascending: false })
        .limit(1)
        .single();

    let nextOrderNumber = 'RPN-0000001';
    if (lastOrder?.order_number) {
        const lastNumber = parseInt(lastOrder.order_number.replace('RPN-', ''), 10);
        if (!isNaN(lastNumber)) {
            nextOrderNumber = `RPN-${String(lastNumber + 1).padStart(7, '0')}`;
        }
    }

    // 2. Insert Transaction
    const { data: transaction, error: transError } = await supabase
        .from('transactions')
        .insert({
            order_number: nextOrderNumber,
            total_amount: total_price_checkout,
            customer_name: customer_name,
            payment_method: 'Cash', // Default for now
            created_at: new Date().toISOString()
        })
        .select()
        .single();

    if (transError) throw transError;
    if (!transaction) throw new Error('Failed to create transaction');

    // 3. Prepare Sales Items (Penjualan)
    const salesItems = items.map((item) => ({
        transaction_id: transaction.id,
        menu_id: item.menu_id,
        variant_type: item.type,
        variant: JSON.stringify(item.topping), // Store array as JSON string
        quantity: item.qty,
        price: item.price,
        total_price: item.total_price,
        order_number: nextOrderNumber
    }));

    // 4. Insert Sales Items
    const { error: itemsError } = await supabase
        .from('penjualan')
        .insert(salesItems);

    if (itemsError) {
        // ideally rollback transaction but supabase-js client doesn't support manual rollback easily. 
        // For this task scope, we assume it works or we throw.
        throw itemsError;
    }

    return { ...transaction, items: salesItems };
};
