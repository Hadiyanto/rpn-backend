import { supabase } from '../config/supabase';
import { transaction } from '../config/db';

export interface OrderItem {
    box_type: 'FULL' | 'HALF' | 'HAMPERS';
    name: string;
    qty: number;
}

export interface CreateOrderPayload {
    customer_name: string;
    customer_phone: string;
    pesanan: OrderItem[];
    pickup_date: string; // ISO date string e.g. '2026-02-26'
    pickup_time?: string;
    note?: string;
    payment_method?: string | null;
}

export interface GetOrdersFilter {
    status?: string;
    day?: string; // e.g. 'RABU'
}

export const createOrder = async (payload: CreateOrderPayload) => {
    const { customer_name, customer_phone, pesanan, pickup_date, pickup_time, note, payment_method } = payload;

    if (!pesanan || pesanan.length === 0) {
        throw new Error('pesanan tidak boleh kosong');
    }

    let requestedQty = 0;
    for (const item of pesanan) {
        if (item.box_type !== 'FULL' && item.box_type !== 'HALF' && item.box_type !== 'HAMPERS') {
            throw new Error(`box_type harus FULL, HALF, atau HAMPERS, got: ${item.box_type}`);
        }
        if (item.box_type === 'HALF') {
            requestedQty += (item.qty * 0.5);
        } else {
            // FULL and HAMPERS cost 1 quota unit
            requestedQty += item.qty;
        }
    }

    return await transaction(async (client) => {
        // --- 1. DAILY QUOTA VALIDATION ---
        // Lock quota row for today to prevent race conditions
        const quotaRes = await client.query('SELECT qty FROM daily_quota WHERE date = $1 FOR UPDATE', [pickup_date]);

        // If quota isn't defined for this date, assume it's closed/full
        if (quotaRes.rowCount === 0) {
            throw new Error(`MOHON MAAF: Penjualan untuk tanggal ${pickup_date} belum dibuka / kuota belum diatur.`);
        }
        const maxQuota = quotaRes.rows[0].qty;

        // Dynamically calculate the currently grouped usage for that date
        // (excluding CANCELLED orders)
        const usedRes = await client.query(`
            SELECT COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 ELSE oi.qty END), 0) as used 
            FROM order_items oi 
            JOIN orders o ON oi.order_id = o.id 
            WHERE o.pickup_date = $1 AND o.status != 'CANCELLED'
        `, [pickup_date]);

        const usedQuota = parseFloat(usedRes.rows[0].used);

        if (usedQuota + requestedQty > maxQuota) {
            const sisa = Math.max(0, maxQuota - usedQuota);
            throw new Error(`MOHON MAAF: Kuota Total untuk tanggal ${pickup_date} sudah penuh. (Sisa: ${sisa} box)`);
        }

        // --- 2. HOURLY QUOTA VALIDATION ---
        if (pickup_time) {
            const hourStr = pickup_time.split(':')[0] + ':00';

            // Lock hourly quota row
            const hourlyRes = await client.query(`
                SELECT qty 
                FROM hourly_quota 
                WHERE time_str = $1 AND is_active = true 
                FOR UPDATE
            `, [hourStr]);

            if (!hourlyRes.rowCount || hourlyRes.rowCount === 0) {
                throw new Error(`MOHON MAAF: Jam pickup ${hourStr} belum dibuka atau sudah ditutup. Silakan pilih jam lain.`);
            }

            const maxHourly = hourlyRes.rows[0].qty;

            // Dynamically calculate the usage for that exact date AND hour block
            const usedHourlyRes = await client.query(`
                SELECT COALESCE(SUM(CASE WHEN oi.box_type = 'HALF' THEN oi.qty * 0.5 ELSE oi.qty END), 0) as used 
                FROM order_items oi 
                JOIN orders o ON oi.order_id = o.id 
                WHERE o.pickup_date = $1 
                  AND o.pickup_time LIKE $2
                  AND o.status != 'CANCELLED'
            `, [pickup_date, `${pickup_time.split(':')[0]}:%`]);

            const usedHourly = parseFloat(usedHourlyRes.rows[0].used);

            if (usedHourly + requestedQty > maxHourly) {
                const sisaHour = Math.max(0, maxHourly - usedHourly);
                throw new Error(`MOHON MAAF: Kuota Jam ${hourStr} di tanggal ${pickup_date} sudah penuh. (Sisa Jam Ini: ${sisaHour} box). Silakan pilih jam lain.`);
            }
        }

        // --- 3. INSERT ORDER ---
        const orderRes = await client.query(`
            INSERT INTO orders (customer_name, customer_phone, pickup_date, pickup_time, note, status, payment_method) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING *
        `, [
            customer_name,
            customer_phone,
            pickup_date,
            pickup_time ?? '11:00 - 16:00',
            note ?? null,
            'UNPAID',
            payment_method ?? null
        ]);

        const order = orderRes.rows[0];

        // 5. Insert order items
        for (const item of pesanan) {
            await client.query(`
                INSERT INTO order_items (order_id, box_type, name, qty) 
                VALUES ($1, $2, $3, $4)
            `, [order.id, item.box_type, item.name, item.qty]);
        }

        return { ...order, items: pesanan };
    });
};

export const getOrders = async (filters?: GetOrdersFilter) => {
    let query = supabase
        .from('orders')
        .select(`
            *,
            items:order_items (
                id,
                box_type,
                name,
                qty
            )
        `)
        .order('pickup_date', { ascending: true });

    if (filters?.status) {
        query = query.eq('status', filters.status.toUpperCase());
    }

    const { data, error } = await query;
    if (error) throw error;

    // Filter by day name if provided (derived from pickup_date)
    if (filters?.day && data) {
        const dayMap: Record<number, string> = {
            0: 'MINGGU',
            1: 'SENIN',
            2: 'SELASA',
            3: 'RABU',
            4: 'KAMIS',
            5: 'JUMAT',
            6: 'SABTU',
        };
        return data.filter((order) => {
            const d = new Date(order.pickup_date);
            return dayMap[d.getDay()] === filters.day!.toUpperCase();
        });
    }

    return data ?? [];
};

export const getOrderById = async (id: number) => {
    const { data, error } = await supabase
        .from('orders')
        .select(`
            *,
            items:order_items (
                id,
                box_type,
                name,
                qty
            )
        `)
        .eq('id', id)
        .single();

    if (error) throw error;
    return data;
};

const VALID_STATUSES = ['UNPAID', 'PAID', 'CONFIRMED', 'DONE', 'CANCELLED'] as const;
export type OrderStatus = typeof VALID_STATUSES[number];

export const updateOrderStatus = async (id: number, status: string) => {
    const upperStatus = status.toUpperCase();

    if (!VALID_STATUSES.includes(upperStatus as OrderStatus)) {
        throw new Error(`Status tidak valid. Pilihan: ${VALID_STATUSES.join(', ')}`);
    }

    const { data, error } = await supabase
        .from('orders')
        .update({ status: upperStatus })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    return data;
};

export interface UpdateOrderPayload {
    customer_name?: string;
    pesanan?: OrderItem[];
    pickup_date?: string;
    pickup_time?: string | null;
    note?: string | null;
    payment_method?: string | null;
    transfer_img_url?: string | null;
}

export const updateOrder = async (id: number, payload: UpdateOrderPayload) => {
    const { customer_name, pesanan, pickup_date, pickup_time, note, payment_method } = payload;

    // 1. Update order header
    const updateFields: Record<string, unknown> = {};
    if (customer_name !== undefined) updateFields.customer_name = customer_name;
    if (pickup_date !== undefined) updateFields.pickup_date = pickup_date;
    if (pickup_time !== undefined) updateFields.pickup_time = pickup_time;
    if (note !== undefined) updateFields.note = note;
    if (payment_method !== undefined) updateFields.payment_method = payment_method;
    if (payload.transfer_img_url !== undefined) updateFields.transfer_img_url = payload.transfer_img_url;

    const { data: order, error: orderError } = await supabase
        .from('orders')
        .update(updateFields)
        .eq('id', id)
        .select()
        .single();

    if (orderError) throw orderError;
    if (!order) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    // 2. Replace items if provided
    if (pesanan && pesanan.length > 0) {
        for (const item of pesanan) {
            if (item.box_type !== 'FULL' && item.box_type !== 'HALF') {
                throw new Error(`box_type harus FULL atau HALF, got: ${item.box_type}`);
            }
        }

        const { error: deleteError } = await supabase
            .from('order_items')
            .delete()
            .eq('order_id', id);

        if (deleteError) throw deleteError;

        const newItems = pesanan.map((item) => ({
            order_id: id,
            box_type: item.box_type,
            name: item.name,
            qty: item.qty,
        }));

        const { error: insertError } = await supabase
            .from('order_items')
            .insert(newItems);

        if (insertError) throw insertError;

        return { ...order, items: pesanan };
    }

    return order;
};

export const updatePaymentMethod = async (id: number, payment_method: string | null) => {
    const { data, error } = await supabase
        .from('orders')
        .update({ payment_method })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    if (!data) throw new Error(`Order dengan id ${id} tidak ditemukan`);

    return data;
};

export const updateTransferImgUrl = async (id: number, transfer_img_url: string | null) => {
    return await transaction(async (client) => {
        // 1. Lock the order row specifically against concurrent modifications
        const res = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);

        if (res.rowCount === 0) {
            throw new Error(`Order dengan id ${id} tidak ditemukan`);
        }

        // 2. Perform the update safely within the lock
        const updateRes = await client.query(`
            UPDATE orders 
            SET transfer_img_url = $1
            WHERE id = $2
            RETURNING *
        `, [transfer_img_url, id]);

        return updateRes.rows[0];
    });
};
