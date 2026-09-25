// Stock becomes per-store: every store keeps its own physical inventory.
exports.up = (pgm) => {
    pgm.addColumns('stock', {
        store_id: { type: 'integer', references: 'stores', onDelete: 'CASCADE' },
    });
    pgm.sql('UPDATE stock SET store_id = 1');
    pgm.alterColumn('stock', 'store_id', { notNull: true });
    pgm.createIndex('stock', 'store_id');
};

exports.down = (pgm) => {
    pgm.dropIndex('stock', 'store_id');
    pgm.dropColumns('stock', ['store_id']);
};
