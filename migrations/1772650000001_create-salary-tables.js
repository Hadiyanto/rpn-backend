exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. salary_config table
    pgm.createTable('salary_config', {
        id: { type: 'serial', primaryKey: true },
        min_box: { type: 'integer', notNull: true },
        max_box: { type: 'integer' }, // Nullable for "30 keatas"
        amount: { type: 'decimal(12, 2)', notNull: true },
        is_fixed: { type: 'boolean', default: false, notNull: true },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
        updated_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // Insert predefined salary configurations
    pgm.sql(`
        INSERT INTO salary_config (min_box, max_box, amount, is_fixed) VALUES
        (0, 15, 150000, true),
        (16, 20, 5000, false),
        (21, 25, 6000, false),
        (26, 30, 7000, false),
        (31, NULL, 3000, false);
    `);

    // 2. daily_salary table
    pgm.createTable('daily_salary', {
        id: { type: 'serial', primaryKey: true },
        date: { type: 'date', notNull: true, unique: true },
        total_boxes: { type: 'integer', notNull: true, default: 0 },
        total_salary: { type: 'decimal(12, 2)', notNull: true, default: 0 },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
        updated_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('daily_salary');
    pgm.dropTable('salary_config');
};
