import { supabase } from '../config/supabase';

export interface OrderItem {
    box_type: 'FULL' | 'HALF';
    name: string;
    qty: number;
}

export interface CreateOrderPayload {
    customer_name: string;
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
    const { customer_name, pesanan, pickup_date, pickup_time, note, payment_method } = payload;

    if (!pesanan || pesanan.length === 0) {
        throw new Error('pesanan tidak boleh kosong');
    }

    for (const item of pesanan) {
        if (item.box_type !== 'FULL' && item.box_type !== 'HALF') {
            throw new Error(`box_type harus FULL atau HALF, got: ${item.box_type}`);
        }
    }

    // 1. Insert order header
    const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
            customer_name,
            pickup_date,
            pickup_time: pickup_time ?? '11:00 - 16:00',
            note: note ?? null,
            status: 'UNPAID',
            payment_method: payment_method ?? null,
        })
        .select()
        .single();

    if (orderError) throw orderError;
    if (!order) throw new Error('Gagal membuat order');

    // 2. Insert order items
    const items = pesanan.map((item) => ({
        order_id: order.id,
        box_type: item.box_type,
        name: item.name,
        qty: item.qty,
    }));

    const { error: itemsError } = await supabase
        .from('order_items')
        .insert(items);

    if (itemsError) throw itemsError;

    return { ...order, items: pesanan };
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

const VALID_STATUSES = ['UNPAID', 'PAID', 'CONFIRMED', 'DONE'] as const;
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
