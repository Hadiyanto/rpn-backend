// The actual variant(s) chosen for each order item (a FULL box can mix several flavors).
// order_items.name stays as the human-readable label.
exports.up = (pgm) => {
    pgm.createTable('order_item_variants', {
        id: { type: 'serial', primaryKey: true },
        order_item_id: { type: 'integer', notNull: true, references: 'order_items', onDelete: 'CASCADE' },
        variant_id: { type: 'integer', notNull: true, references: 'variant' },
    });
    pgm.addConstraint('order_item_variants', 'order_item_variants_unique', { unique: ['order_item_id', 'variant_id'] });
};

exports.down = (pgm) => {
    pgm.dropTable('order_item_variants');
};
