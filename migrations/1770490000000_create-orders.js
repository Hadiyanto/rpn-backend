exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. Orders Table (Header)
    pgm.createTable('orders', {
        id: { type: 'serial', primaryKey: true },
        customer_name: { type: 'varchar(255)', notNull: true },
        pickup_date: { type: 'date', notNull: true },
        pickup_time: { type: 'varchar(50)', default: "'11:00 - 16:00'" },
        note: { type: 'text' },
        status: {
            type: 'varchar(20)',
            notNull: true,
            default: "'PENDING'",
        },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // 2. Order Items Table (Detail)
    pgm.createTable('order_items', {
        id: { type: 'serial', primaryKey: true },
        order_id: {
            type: 'integer',
            notNull: true,
            references: '"orders"',
            onDelete: 'CASCADE',
        },
        box_type: { type: 'varchar(10)', notNull: true }, // 'FULL' or 'HALF'
        name: { type: 'varchar(255)', notNull: true },
        qty: { type: 'integer', notNull: true },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('order_items');
    pgm.dropTable('orders');
};
