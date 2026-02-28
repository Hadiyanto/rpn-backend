exports.up = (pgm) => {
    pgm.addColumn('orders', {
        customer_phone: { type: 'varchar(50)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('orders', 'customer_phone');
};
