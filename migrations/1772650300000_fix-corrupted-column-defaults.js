exports.shorthands = undefined;

// The original create-orders / add-* migrations passed already-quoted strings
// (e.g. "'11:00 - 16:00'") as the default value, which node-pg-migrate then
// quoted AGAIN — so the stored default became the literal 15-character string
// `'11:00 - 16:00'` (with quote marks baked in), not the clean value. The app
// currently always supplies these columns explicitly on INSERT so this never
// surfaced, but any future direct insert would silently write corrupted data.
exports.up = (pgm) => {
    pgm.alterColumn('orders', 'pickup_time', { default: '11:00 - 16:00' });
    pgm.alterColumn('orders', 'status', { default: 'UNPAID' }); // 'PENDING' was never a valid app status
    pgm.alterColumn('orders', 'delivery_method', { default: 'pickup' });
};

exports.down = (pgm) => {
    pgm.alterColumn('orders', 'pickup_time', { default: "'11:00 - 16:00'" });
    pgm.alterColumn('orders', 'status', { default: "'PENDING'" });
    pgm.alterColumn('orders', 'delivery_method', { default: "'pickup'" });
};
