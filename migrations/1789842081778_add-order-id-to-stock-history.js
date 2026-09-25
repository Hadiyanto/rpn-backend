// Links automatic stock movements to the order that caused them, so deductions can be
// made idempotent and reversed exactly when an order is cancelled or edited.
exports.up = (pgm) => {
    pgm.addColumns('stock_history', {
        order_id: { type: 'integer', references: 'orders', onDelete: 'SET NULL' },
    });
    pgm.createIndex('stock_history', 'order_id');
};

exports.down = (pgm) => {
    pgm.dropIndex('stock_history', 'order_id');
    pgm.dropColumns('stock_history', ['order_id']);
};
