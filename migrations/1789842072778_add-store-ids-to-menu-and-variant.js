exports.up = (pgm) => {
    pgm.addColumns('menu', {
        store_ids: { type: 'integer[]', notNull: true, default: pgm.func("'{1,2}'") },
    });
    pgm.addColumns('variant', {
        store_ids: { type: 'integer[]', notNull: true, default: pgm.func("'{1,2}'") },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('menu', ['store_ids']);
    pgm.dropColumns('variant', ['store_ids']);
};
