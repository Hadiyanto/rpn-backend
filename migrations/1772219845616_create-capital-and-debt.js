/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
    pgm.createTable('capital', {
        id: 'id',
        amount: { type: 'integer', notNull: true },
        note: { type: 'text', notNull: false },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        }
    });

    pgm.createTable('debt', {
        id: 'id',
        source: { type: 'varchar(255)', notNull: true },
        total_amount: { type: 'integer', notNull: true },
        remaining_amount: { type: 'integer', notNull: true },
        status: { type: 'varchar(50)', notNull: true, default: 'ACTIVE' }, // ACTIVE | PAID
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        }
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
    pgm.dropTable('debt');
    pgm.dropTable('capital');
};
