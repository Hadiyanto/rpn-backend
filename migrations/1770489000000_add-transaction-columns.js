/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // Add columns to transactions table
    pgm.addColumns('transactions', {
        customer_name: { type: 'varchar(255)' }, // Optional, can be null
        order_number: { type: 'varchar(50)' },   // Distinct order identifier
    });

    // Add order_number to penjualan for easier tracking/grouping if needed
    pgm.addColumns('penjualan', {
        order_number: { type: 'varchar(50)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('penjualan', 'order_number');
    pgm.dropColumns('transactions', ['customer_name', 'order_number']);
};
