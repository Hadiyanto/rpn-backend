exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumn('orders', {
        payment_method: {
            type: 'varchar(50)',
            notNull: false,
        },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('orders', 'payment_method');
};
