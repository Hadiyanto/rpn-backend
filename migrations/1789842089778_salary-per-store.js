// Salary per store (docs/plan-gaji.md): tiers and daily salary per store, the daily salary is
// booked as an expense automatically, expenses belong to a store (NULL = shared/general), and a
// store can take its labor cost for HPP from another store.
exports.up = (pgm) => {
    // salary_config: every store gets its own copy of the current tiers.
    pgm.addColumns('salary_config', { store_id: { type: 'integer', references: 'stores', onDelete: 'CASCADE' } });
    pgm.sql(`
        INSERT INTO salary_config (min_box, max_box, amount, is_fixed, store_id)
        SELECT c.min_box, c.max_box, c.amount, c.is_fixed, s.id
        FROM salary_config c CROSS JOIN stores s
        WHERE c.store_id IS NULL
    `);
    pgm.sql('DELETE FROM salary_config WHERE store_id IS NULL');
    pgm.alterColumn('salary_config', 'store_id', { notNull: true });
    pgm.createIndex('salary_config', ['store_id', 'min_box']);

    // daily_salary: one row per store per day, with the tier breakdown.
    pgm.addColumns('daily_salary', {
        store_id: { type: 'integer', references: 'stores', onDelete: 'CASCADE' },
        breakdown: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    });
    pgm.sql('UPDATE daily_salary SET store_id = (SELECT min(id) FROM stores) WHERE store_id IS NULL');
    pgm.alterColumn('daily_salary', 'store_id', { notNull: true });
    pgm.dropConstraint('daily_salary', 'daily_salary_date_key', { ifExists: true });
    pgm.addConstraint('daily_salary', 'daily_salary_date_store_key', { unique: ['date', 'store_id'] });

    // pengeluaran: per store (NULL = general), and the row booked for a daily salary.
    pgm.addColumns('pengeluaran', {
        store_id: { type: 'integer', references: 'stores', onDelete: 'SET NULL' },
        daily_salary_id: { type: 'integer', references: 'daily_salary', onDelete: 'CASCADE', unique: true },
    });
    pgm.createIndex('pengeluaran', ['store_id', 'date']);

    // stores: HPP labor cost = salary(target) / target of this store, or of the reference store.
    pgm.addColumns('stores', {
        labor_target_boxes: { type: 'integer', notNull: true, default: 30 },
        labor_reference_store_id: { type: 'integer', references: 'stores', onDelete: 'SET NULL' },
    });
    pgm.addConstraint('stores', 'stores_labor_target_boxes_check', { check: 'labor_target_boxes > 0' });
    // Depok is run by the owner for now: its HPP uses Kalibata's labor cost.
    pgm.sql(`
        UPDATE stores s SET labor_reference_store_id = k.id
        FROM stores k
        WHERE s.name ILIKE '%depok%' AND k.name ILIKE '%kalibata%'
    `);
};

exports.down = (pgm) => {
    pgm.dropConstraint('stores', 'stores_labor_target_boxes_check');
    pgm.dropColumns('stores', ['labor_target_boxes', 'labor_reference_store_id']);
    pgm.dropColumns('pengeluaran', ['store_id', 'daily_salary_id']);
    pgm.dropConstraint('daily_salary', 'daily_salary_date_store_key');
    pgm.sql('DELETE FROM daily_salary a USING daily_salary b WHERE a.date = b.date AND a.id > b.id');
    pgm.addConstraint('daily_salary', 'daily_salary_date_key', { unique: ['date'] });
    pgm.dropColumns('daily_salary', ['store_id', 'breakdown']);
    pgm.sql('DELETE FROM salary_config a USING salary_config b WHERE a.min_box = b.min_box AND a.store_id > b.store_id');
    pgm.dropColumns('salary_config', ['store_id']);
};
