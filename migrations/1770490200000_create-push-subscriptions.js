/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
    pgm.createTable('push_subscriptions', {
        id: { type: 'serial', primaryKey: true },
        endpoint: { type: 'text', notNull: true, unique: true },
        p256dh: { type: 'text', notNull: true },
        auth: { type: 'text', notNull: true },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('push_subscriptions');
};
