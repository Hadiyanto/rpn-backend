// "Pemakaian stock per box": grams of each stock item used by ONE FULL box of a variant, per store.
exports.up = (pgm) => {
    pgm.createTable('variant_recipe', {
        id: { type: 'serial', primaryKey: true },
        variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        store_id: { type: 'integer', notNull: true, references: 'stores', onDelete: 'CASCADE' },
        stock_id: { type: 'integer', notNull: true, references: 'stock', onDelete: 'CASCADE' },
        qty_gram: { type: 'numeric(10,2)', notNull: true },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('variant_recipe', 'variant_recipe_unique', { unique: ['variant_id', 'store_id', 'stock_id'] });
    pgm.addConstraint('variant_recipe', 'variant_recipe_qty_gram_check', { check: 'qty_gram > 0' });
    pgm.createIndex('variant_recipe', ['store_id', 'variant_id']);
};

exports.down = (pgm) => {
    pgm.dropTable('variant_recipe');
};
