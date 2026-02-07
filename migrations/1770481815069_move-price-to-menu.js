exports.shorthands = undefined;

exports.up = (pgm) => {
    // Remove price column from variant table
    pgm.dropColumn('variant', 'price');

    // Add price column to menu table
    pgm.addColumn('menu', {
        price: { type: 'decimal(12, 2)' }, // Removed notNull causing it to be updateable/nullable? Or just default behavior.
    });
};

exports.down = (pgm) => {
    // Add price column back to variant table
    pgm.addColumn('variant', {
        price: { type: 'decimal(12, 2)', notNull: true, default: 0 },
    });

    // Remove price column from menu table
    pgm.dropColumn('menu', 'price');
};
