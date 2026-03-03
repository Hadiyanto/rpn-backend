import { supabase } from '../config/supabase';

export interface SalaryConfigDTO {
    min_box: number;
    max_box: number | null;
    amount: number;
    is_fixed: boolean;
}

export const getSalaryConfig = async () => {
    const { data, error } = await supabase
        .from('salary_config')
        .select('*')
        .order('min_box', { ascending: true });

    if (error) throw error;
    return data ?? [];
};

export const updateSalaryConfig = async (configs: SalaryConfigDTO[]) => {
    // Replace all existing configs
    const { error: deleteErr } = await supabase
        .from('salary_config')
        .delete()
        .neq('id', 0); // Delete all rows

    if (deleteErr) throw deleteErr;

    const { data, error } = await supabase
        .from('salary_config')
        .insert(configs)
        .select();

    if (error) throw error;
    return data ?? [];
};

export const getDailySalaries = async () => {
    const { data, error } = await supabase
        .from('daily_salary')
        .select('*')
        .order('date', { ascending: false });

    if (error) throw error;
    return data ?? [];
};

export const calculateSalaryPreview = async (date: string) => {
    // 1. Calculate total boxes sold on that date with status PAID or DONE
    const { data: orders, error: orderErr } = await supabase
        .from('orders')
        .select(`
            id,
            status,
            order_items (
                box_type,
                qty
            )
        `)
        .eq('pickup_date', date)
        .in('status', ['PAID', 'DONE']);

    if (orderErr) throw orderErr;

    let totalBoxes = 0;
    if (orders) {
        for (const order of orders) {
            if (order.order_items) {
                const items = Array.isArray(order.order_items) ? order.order_items : [order.order_items];
                for (const item of items) {
                    if (item.box_type === 'FULL') totalBoxes += item.qty;
                    if (item.box_type === 'HALF') totalBoxes += (item.qty * 0.5);
                }
            }
        }
    }

    // PEMBULATAN KEATAS untuk pencarian range dan kalkulasi nominal
    const boxCountInt = Math.ceil(totalBoxes);

    // 2. Load salary configs
    const configs = await getSalaryConfig();
    let totalSalary = 0;

    // Find matching range
    const matchingConfig = configs.find(c => {
        if (c.max_box === null) return boxCountInt >= c.min_box;
        return boxCountInt >= c.min_box && boxCountInt <= c.max_box;
    });

    if (matchingConfig) {
        if (matchingConfig.is_fixed) {
            totalSalary = Number(matchingConfig.amount);
        } else {
            totalSalary = boxCountInt * Number(matchingConfig.amount); // Gunakan jumlah yang sudah dibulatkan keatas
        }
    }

    return {
        date,
        totalBoxesRaw: totalBoxes,
        totalBoxesRounded: boxCountInt,
        totalSalary
    };
};

export const generateDailySalary = async (date: string) => {
    const preview = await calculateSalaryPreview(date);

    // 3. Upsert into daily_salary
    const { data: savedSalary, error: saveErr } = await supabase
        .from('daily_salary')
        .upsert({
            date: date,
            total_boxes: preview.totalBoxesRounded, // Simpan hasil pembulatan ke database
            total_salary: preview.totalSalary,
            updated_at: new Date().toISOString()
        }, { onConflict: 'date' })
        .select()
        .single();

    if (saveErr) throw saveErr;

    return savedSalary;
};
