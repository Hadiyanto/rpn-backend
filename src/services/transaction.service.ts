import { pool, transaction as dbTransaction, insertRow } from '../config/db';

export const getTransactions = async () => {
    const { rows } = await pool.query('SELECT * FROM transactions ORDER BY date DESC');
    return rows;
};

/** POS checkout: header + sales lines in ONE transaction (the supabase-js version could leave a header without lines). */
export const createTransaction = async (items: any[], total_price_checkout: number, customer_name: string) =>
    dbTransaction(async (client) => {
        // 1. Generate Order Number. The advisory lock serializes concurrent checkouts so two of
        // them can't read the same "last" number.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('transactions.order_number'))");
        const { rows: [lastOrder] } = await client.query('SELECT order_number FROM transactions ORDER BY id DESC LIMIT 1');

        let nextOrderNumber = 'RPN-0000001';
        if (lastOrder?.order_number) {
            const lastNumber = parseInt(lastOrder.order_number.replace('RPN-', ''), 10);
            if (!isNaN(lastNumber)) {
                nextOrderNumber = `RPN-${String(lastNumber + 1).padStart(7, '0')}`;
            }
        }

        // 2. Insert Transaction
        const header = await insertRow('transactions', {
            order_number: nextOrderNumber,
            total_amount: total_price_checkout,
            customer_name,
            payment_method: 'Cash', // Default for now
        }, client);

        // 3. Sales Items (Penjualan)
        const salesItems = items.map((item) => ({
            transaction_id: header.id,
            menu_id: item.menu_id,
            variant_type: item.type,
            variant: JSON.stringify(item.topping), // Store array as JSON string
            quantity: item.qty,
            price: item.price,
            total_price: item.total_price,
            order_number: nextOrderNumber,
        }));
        for (const line of salesItems) {
            await insertRow('penjualan', line, client);
        }

        return { ...header, items: salesItems };
    });
