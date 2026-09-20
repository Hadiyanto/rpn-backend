exports.up = (pgm) => {
    pgm.addColumns('hourly_quota', {
        store_id: { type: 'integer', references: 'stores', onDelete: 'CASCADE' },
    });
    pgm.sql('UPDATE hourly_quota SET store_id = 1');
    pgm.alterColumn('hourly_quota', 'store_id', { notNull: true });
    pgm.dropConstraint('hourly_quota', 'hourly_quota_time_str_key');
    pgm.addConstraint('hourly_quota', 'hourly_quota_store_id_time_str_key', {
        unique: ['store_id', 'time_str'],
    });
};

exports.down = (pgm) => {
    pgm.dropConstraint('hourly_quota', 'hourly_quota_store_id_time_str_key');
    pgm.addConstraint('hourly_quota', 'hourly_quota_time_str_key', { unique: ['time_str'] });
    pgm.dropColumns('hourly_quota', ['store_id']);
};
