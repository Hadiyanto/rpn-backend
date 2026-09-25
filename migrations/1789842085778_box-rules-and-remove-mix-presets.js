// - Preset mixes ("Mix 3") are gone: a FULL box can freely mix up to 3 flavors, so
//   variant_components is dropped.
// - Shipping size/weight per box type live on the menu row instead of being hardcoded in
//   the frontend and the Biteship dispatch.
// - Each store can show its own QRIS image instead of a placeholder.
exports.up = (pgm) => {
    pgm.dropTable('variant_components', { ifExists: true });

    pgm.addColumns('menu', {
        weight_gram: { type: 'integer' },
        length_cm: { type: 'integer' },
        width_cm: { type: 'integer' },
        height_cm: { type: 'integer' },
    });
    // Same values the code used to hardcode.
    pgm.sql("UPDATE menu SET weight_gram = 1000, length_cm = 20, width_cm = 20, height_cm = 10 WHERE name = 'FULL'");
    pgm.sql("UPDATE menu SET weight_gram = 500, length_cm = 10, width_cm = 10, height_cm = 10 WHERE name = 'HALF'");

    pgm.addColumns('stores', {
        qris_image_url: { type: 'text' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('stores', ['qris_image_url']);
    pgm.dropColumns('menu', ['weight_gram', 'length_cm', 'width_cm', 'height_cm']);
    pgm.createTable('variant_components', {
        id: { type: 'serial', primaryKey: true },
        variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        component_variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('variant_components', 'variant_components_unique', { unique: ['variant_id', 'component_variant_id'] });
    pgm.addConstraint('variant_components', 'variant_components_not_self_check', { check: 'variant_id <> component_variant_id' });
};
