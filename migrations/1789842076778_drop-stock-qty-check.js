// Product decision: an order is never blocked by missing stock, so auto-deduction may
// push qty below zero. The old qty >= 0 check would make every such deduction fail.
exports.up = (pgm) => {
    pgm.dropConstraint('stock', 'stock_qty_check');
};

exports.down = (pgm) => {
    // NOT VALID: existing negative rows (if any) don't block the rollback.
    pgm.sql('ALTER TABLE stock ADD CONSTRAINT stock_qty_check CHECK (qty >= 0) NOT VALID');
};
