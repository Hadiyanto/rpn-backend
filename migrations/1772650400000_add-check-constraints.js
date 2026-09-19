exports.shorthands = undefined;

// Data verified clean against these constraints before writing this migration:
// orders.status: only CANCELLED/DONE currently present (subset of VALID_STATUSES)
// orders.payment_method: only TRANSFER/CASH/NULL currently present
// order_items.box_type: only FULL/HALF currently present (HAMPERS allowed, unused so far)
// stock.qty: no negative rows
// menu.price: no NULL rows
exports.up = (pgm) => {
    pgm.addConstraint('orders', 'orders_status_check', {
        check: "status IN ('UNPAID', 'PAID', 'CONFIRMED', 'DONE', 'CANCELLED')",
    });
    pgm.addConstraint('orders', 'orders_payment_method_check', {
        check: "payment_method IS NULL OR payment_method IN ('TRANSFER', 'CASH')",
    });
    pgm.addConstraint('order_items', 'order_items_box_type_check', {
        check: "box_type IN ('FULL', 'HALF', 'HAMPERS')",
    });
    pgm.addConstraint('stock', 'stock_qty_check', {
        check: 'qty >= 0',
    });

    pgm.alterColumn('menu', 'price', { notNull: true, default: 0 });
    pgm.addConstraint('menu', 'menu_price_check', {
        check: 'price >= 0',
    });
};

exports.down = (pgm) => {
    pgm.dropConstraint('menu', 'menu_price_check');
    pgm.alterColumn('menu', 'price', { notNull: false, default: null });
    pgm.dropConstraint('stock', 'stock_qty_check');
    pgm.dropConstraint('order_items', 'order_items_box_type_check');
    pgm.dropConstraint('orders', 'orders_payment_method_check');
    pgm.dropConstraint('orders', 'orders_status_check');
};
