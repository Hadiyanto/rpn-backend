// Selling price per flavor per store (docs/plan-harga-per-rasa.md), and the price of each box
// snapshotted on the order so totals no longer depend on today's menu price.
exports.up = (pgm) => {
    pgm.createTable('variant_price', {
        id: { type: 'serial', primaryKey: true },
        variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        store_id: { type: 'integer', notNull: true, references: 'stores', onDelete: 'CASCADE' },
        price_full: { type: 'numeric(12,2)' },
        price_half: { type: 'numeric(12,2)' },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('variant_price', 'variant_price_unique', { unique: ['variant_id', 'store_id'] });
    pgm.addConstraint('variant_price', 'variant_price_check', { check: '(price_full IS NULL OR price_full >= 0) AND (price_half IS NULL OR price_half >= 0)' });

    // Starting prices for every flavor at the stores that have its recipe, by name:
    // cheese/special 68.000 / 37.000, oreo 65.000 / 35.000, basic 60.000 / 32.500.
    pgm.sql(`
        INSERT INTO variant_price (variant_id, store_id, price_full, price_half)
        SELECT v.id, r.store_id,
               CASE WHEN v.variant_name ILIKE '%cheese%' OR v.variant_name ILIKE '%special%' THEN 68000
                    WHEN v.variant_name ILIKE '%oreo%' THEN 65000 ELSE 60000 END,
               CASE WHEN v.variant_name ILIKE '%cheese%' OR v.variant_name ILIKE '%special%' THEN 37000
                    WHEN v.variant_name ILIKE '%oreo%' THEN 35000 ELSE 32500 END
        FROM variant v
        JOIN (SELECT DISTINCT variant_id, store_id FROM variant_recipe) r ON r.variant_id = v.id
    `);

    pgm.addColumns('order_items', {
        unit_price: { type: 'numeric(12,2)' },
        // The flavor whose price set the box price (the most expensive one).
        price_variant_id: { type: 'integer', references: 'variant', onDelete: 'SET NULL' },
    });
    pgm.sql(`
        UPDATE order_items oi SET unit_price = m.price
        FROM (SELECT DISTINCT ON (name) name, price FROM menu ORDER BY name, is_active DESC NULLS LAST, id) m
        WHERE m.name = oi.box_type AND oi.unit_price IS NULL
    `);
};

exports.down = (pgm) => {
    pgm.dropColumns('order_items', ['unit_price', 'price_variant_id']);
    pgm.dropTable('variant_price');
};
