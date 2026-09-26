// "Bahan dasar": grams of each stock item used by EVERY box (any flavor), per FULL box, per store.
// Scaled by menu.box_multiplier like flavor recipes (HALF = 0.5) but not split between flavors.
// qty_gram 0 = listed but not measured yet (counts as nothing).
exports.up = (pgm) => {
    pgm.createTable('base_recipe', {
        id: { type: 'serial', primaryKey: true },
        store_id: { type: 'integer', notNull: true, references: 'stores', onDelete: 'CASCADE' },
        stock_id: { type: 'integer', notNull: true, references: 'stock', onDelete: 'CASCADE' },
        qty_gram: { type: 'numeric(10,2)', notNull: true, default: 0 },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('base_recipe', 'base_recipe_unique', { unique: ['store_id', 'stock_id'] });
    pgm.addConstraint('base_recipe', 'base_recipe_qty_gram_check', { check: 'qty_gram >= 0' });
    pgm.createIndex('base_recipe', 'store_id');
    // The batter ingredients used by every box; grams are filled in later from the UI.
    pgm.sql(`
        INSERT INTO base_recipe (store_id, stock_id, qty_gram)
        SELECT store_id, id, 0 FROM stock WHERE lower(item_name) IN ('t.panir', 't.sasa')
        ON CONFLICT DO NOTHING
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('base_recipe');
};
