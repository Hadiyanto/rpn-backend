exports.up = (pgm) => {
    pgm.addColumns('orders', {
        store_id: { type: 'integer', references: 'stores' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['store_id']);
};
