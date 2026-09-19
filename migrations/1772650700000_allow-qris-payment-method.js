exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.dropConstraint('orders', 'orders_payment_method_check');
    pgm.addConstraint('orders', 'orders_payment_method_check', {
        check: "payment_method IS NULL OR payment_method IN ('TRANSFER', 'CASH', 'QRIS')",
    });
};

exports.down = (pgm) => {
    pgm.dropConstraint('orders', 'orders_payment_method_check');
    pgm.addConstraint('orders', 'orders_payment_method_check', {
        check: "payment_method IS NULL OR payment_method IN ('TRANSFER', 'CASH')",
    });
};
