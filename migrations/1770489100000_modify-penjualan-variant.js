/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. Rename variant_id to variant and change type to varchar, remove FK constraint
    // First drop the constraint if it exists. The constraint name is usually table_column_fkey
    pgm.dropConstraint('penjualan', 'penjualan_variant_id_fkey', { ifExists: true });

    // Rename column
    pgm.renameColumn('penjualan', 'variant_id', 'variant');

    // Change column type to varchar/text
    pgm.alterColumn('penjualan', 'variant', {
        type: 'text', // Using text to accommodate arrays if stringified or long strings
        default: null,
        using: 'variant::text', // Cast existing values if any
    });

    // 2. Add variant_type column
    pgm.addColumns('penjualan', {
        variant_type: { type: 'varchar(50)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('penjualan', 'variant_type');

    // Revert variant column to variant_id integer
    pgm.alterColumn('penjualan', 'variant', {
        type: 'integer',
        using: 'variant::integer', // This might fail if text values are present, but it's a down migration
    });

    pgm.renameColumn('penjualan', 'variant', 'variant_id');

    pgm.addConstraint('penjualan', 'penjualan_variant_id_fkey', {
        foreignKeys: {
            columns: 'variant_id',
            references: '"variant"(id)',
            onDelete: 'SET NULL',
        },
    });
};
