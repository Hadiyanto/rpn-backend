// HPP: purchase price per unit (latest purchase wins) and the total paid per stock-in.
exports.up = (pgm) => {
    pgm.addColumns('stock', {
        price_per_unit: { type: 'numeric(12,4)' },
    });
    pgm.addColumns('stock_history', {
        total_price: { type: 'numeric(12,2)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('stock_history', ['total_price']);
    pgm.dropColumns('stock', ['price_per_unit']);
};
