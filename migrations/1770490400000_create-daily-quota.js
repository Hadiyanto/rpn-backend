exports.up = (pgm) => {
    pgm.createTable('daily_quota', {
        id: 'id',
        date: { type: 'date', notNull: true, unique: true },
        qty: { type: 'integer', notNull: true, default: 0 },
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
    pgm.dropTable('daily_quota');
};
