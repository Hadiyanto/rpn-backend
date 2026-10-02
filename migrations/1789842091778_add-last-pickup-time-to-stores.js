// Latest pickup time per store, configurable in /config → Store. Also bounds the pickup hours
// offered when a store has no hourly quota slots configured.
exports.up = (pgm) => {
    pgm.addColumns('stores', {
        last_pickup_time: { type: 'varchar(5)', notNull: true, default: '17:00' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('stores', ['last_pickup_time']);
};
