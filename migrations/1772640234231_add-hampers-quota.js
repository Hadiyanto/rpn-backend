exports.up = (pgm) => {
    pgm.addColumns('daily_quota', { hampers_qty: { type: 'integer', notNull: true, default: 0 } });
    pgm.addColumns('hourly_quota', { hampers_qty: { type: 'integer', notNull: true, default: 0 } });
};

exports.down = (pgm) => {
    pgm.dropColumns('daily_quota', ['hampers_qty']);
    pgm.dropColumns('hourly_quota', ['hampers_qty']);
};
