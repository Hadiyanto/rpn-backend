// Admin push when a Biteship attempt fails or is cancelled by the provider: sent once per attempt
// (set atomically, like delivery_notified_at for "delivered").
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('order_delivery_attempts', { failure_notified_at: { type: 'timestamptz' } });
};

exports.down = (pgm) => {
    pgm.dropColumns('order_delivery_attempts', ['failure_notified_at']);
};
