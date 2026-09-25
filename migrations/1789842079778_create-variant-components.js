// Composition of preset mix variants (e.g. "Mix 3 (...)"): a preset's recipe is derived
// from its component flavors. Not per-store — the composition is the same everywhere.
// No seed: admins fill this in /config after checking the real variant ids.
exports.up = (pgm) => {
    pgm.createTable('variant_components', {
        id: { type: 'serial', primaryKey: true },
        variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        component_variant_id: { type: 'integer', notNull: true, references: 'variant', onDelete: 'CASCADE' },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('variant_components', 'variant_components_unique', { unique: ['variant_id', 'component_variant_id'] });
    pgm.addConstraint('variant_components', 'variant_components_not_self_check', { check: 'variant_id <> component_variant_id' });
};

exports.down = (pgm) => {
    pgm.dropTable('variant_components');
};
