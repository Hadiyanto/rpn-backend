exports.up = (pgm) => {
    pgm.createTable('hourly_quota', {
        id: 'id',
        time_str: { type: 'varchar(10)', notNull: true, unique: true },
        qty: { type: 'integer', notNull: true, default: 0 },
        is_active: { type: 'boolean', notNull: true, default: true },
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
    pgm.dropTable('hourly_quota');
};
