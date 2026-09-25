// Cost per unit at the moment of each stock movement (the stock's weighted-average price then).
// Order deductions keep their cost even when purchase prices change later, so the HPP of past
// orders never moves. NULL when the stock had no price yet.
exports.up = (pgm) => {
    pgm.addColumns('stock_history', {
        unit_cost: { type: 'numeric(12,4)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('stock_history', ['unit_cost']);
};
