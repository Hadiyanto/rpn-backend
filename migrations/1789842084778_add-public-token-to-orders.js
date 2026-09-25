// Unguessable token for customer-facing links (WA "upload bukti transfer" link), so orders
// can't be enumerated through sequential ids. gen_random_uuid() is built into Postgres 13+.
exports.up = (pgm) => {
    pgm.addColumns('orders', {
        public_token: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()') },
    });
    pgm.addConstraint('orders', 'orders_public_token_key', { unique: ['public_token'] });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['public_token']);
};
