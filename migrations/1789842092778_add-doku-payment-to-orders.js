// DOKU Checkout (DOKU_PAYMENT=true): the order is paid on DOKU's hosted checkout page.
// doku_invoice_number is what DOKU knows the order by (notifications + check status look it up).
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.dropConstraint('orders', 'orders_payment_method_check');
    pgm.addConstraint('orders', 'orders_payment_method_check', {
        check: "payment_method IS NULL OR payment_method IN ('TRANSFER', 'CASH', 'QRIS', 'DOKU')",
    });

    pgm.addColumns('orders', {
        doku_invoice_number: { type: 'varchar(64)' },
        doku_payment_url: { type: 'text' },
        // Checkout page expiry as returned by DOKU (yyyyMMddHHmmss, WIB) converted to a timestamp.
        doku_expired_at: { type: 'timestamptz' },
        // Channel the customer actually paid with, e.g. VIRTUAL_ACCOUNT_BCA / QRIS_DOKU.
        doku_paid_channel: { type: 'varchar(64)' },
        doku_paid_at: { type: 'timestamptz' },
    });
    pgm.addConstraint('orders', 'orders_doku_invoice_number_key', { unique: ['doku_invoice_number'] });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['doku_invoice_number', 'doku_payment_url', 'doku_expired_at', 'doku_paid_channel', 'doku_paid_at']);
    pgm.dropConstraint('orders', 'orders_payment_method_check');
    pgm.addConstraint('orders', 'orders_payment_method_check', {
        check: "payment_method IS NULL OR payment_method IN ('TRANSFER', 'CASH', 'QRIS')",
    });
};
