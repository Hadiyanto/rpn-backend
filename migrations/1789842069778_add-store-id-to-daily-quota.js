exports.up = (pgm) => {
    pgm.addColumns('daily_quota', {
        store_id: { type: 'integer', references: 'stores', onDelete: 'CASCADE' },
    });
    pgm.sql('UPDATE daily_quota SET store_id = 1');
    pgm.alterColumn('daily_quota', 'store_id', { notNull: true });
    pgm.dropConstraint('daily_quota', 'daily_quota_date_key');
    pgm.addConstraint('daily_quota', 'daily_quota_store_id_date_key', {
        unique: ['store_id', 'date'],
    });
};

exports.down = (pgm) => {
    pgm.dropConstraint('daily_quota', 'daily_quota_store_id_date_key');
    pgm.addConstraint('daily_quota', 'daily_quota_date_key', { unique: ['date'] });
    pgm.dropColumns('daily_quota', ['store_id']);
};
