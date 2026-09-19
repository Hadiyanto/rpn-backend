exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('orders', {
        updated_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['updated_at']);
};
