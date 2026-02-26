/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
    pgm.createTable('user_roles', {
        user_id: { type: 'uuid', primaryKey: true, references: '"auth"."users"(id)' },
        email: { type: 'text', notNull: true },
        role: { type: 'varchar(50)', notNull: true, default: pgm.func("'staff'") },
        allowed_pages: { type: 'text[]', notNull: true, default: pgm.func("'{orders}'") },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('user_roles');
};
