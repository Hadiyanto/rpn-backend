exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.createTable('stock_history', {
        id: { type: 'serial', primaryKey: true },
        stock_id: {
            type: 'integer',
            notNull: true,
            references: '"stock"', // quotes are important if casing matters, but lowercase is fine
            onDelete: 'CASCADE',
        },
        type: { type: 'varchar(50)', notNull: true }, // 'IN', 'OUT', 'ADJUSTMENT'
        qty_change: { type: 'decimal(10, 2)', notNull: true },
        final_qty: { type: 'decimal(10, 2)', notNull: true },
        notes: { type: 'text' },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('stock_history');
};
