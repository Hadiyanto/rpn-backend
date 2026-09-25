import { pool, transaction, insertRow } from '../config/db';
import { BOX_UNITS_SQL } from '../utils/boxUnits';

export interface SalaryConfigDTO {
    min_box: number;
    max_box: number | null;
    amount: number;
    is_fixed: boolean;
}

export const getSalaryConfig = async () => {
    const { rows } = await pool.query('SELECT * FROM salary_config ORDER BY min_box ASC');
    return rows;
};

export const updateSalaryConfig = async (configs: SalaryConfigDTO[]) => {
    // Replace all existing configs — in one transaction, so a failed insert can't leave the
    // table empty (the supabase-js version deleted first and inserted separately).
    return transaction(async (client) => {
        await client.query('DELETE FROM salary_config');
        const saved = [];
        for (const c of configs) {
            saved.push(await insertRow('salary_config', {
                min_box: c.min_box,
                max_box: c.max_box,
                amount: c.amount,
                is_fixed: c.is_fixed,
            }, client));
        }
        return saved;
    });
};

export const getDailySalaries = async () => {
    const { rows } = await pool.query('SELECT * FROM daily_salary ORDER BY date DESC');
    return rows;
};

export const calculateSalaryPreview = async (date: string) => {
    // 1. Total boxes sold on that date with status PAID or DONE (FULL = 1, HALF = 0.5)
    const { rows: [sum] } = await pool.query(`
        SELECT COALESCE(SUM(${BOX_UNITS_SQL}), 0) AS total_boxes
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.pickup_date = $1::date
          AND o.status IN ('PAID', 'DONE')
    `, [date]);
    const totalBoxes = Number(sum.total_boxes);

    // PEMBULATAN KEATAS untuk pencarian range dan kalkulasi nominal
    const boxCountInt = Math.ceil(totalBoxes);

    // 2. Load salary configs
    const configs = await getSalaryConfig();
    let totalSalary = 0;

    // Progressive calculation
    for (const config of configs) {
        if (boxCountInt < config.min_box) continue;

        const rangeMax = config.max_box === null ? boxCountInt : config.max_box;
        const boxesInRange = Math.min(boxCountInt, rangeMax) - config.min_box + 1;

        if (boxesInRange > 0) {
            if (config.is_fixed) {
                totalSalary += Number(config.amount);
            } else {
                totalSalary += boxesInRange * Number(config.amount);
            }
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
    const { rows } = await pool.query(`
        INSERT INTO daily_salary (date, total_boxes, total_salary, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (date) DO UPDATE
        SET total_boxes = EXCLUDED.total_boxes, total_salary = EXCLUDED.total_salary, updated_at = CURRENT_TIMESTAMP
        RETURNING *
    `, [date, preview.totalBoxesRounded /* Simpan hasil pembulatan ke database */, preview.totalSalary]);

    return rows[0];
};
