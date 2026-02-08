/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.dropColumn('variant', 'menu_id');
};

exports.down = (pgm) => {
    pgm.addColumn('variant', {
        menu_id: {
            type: 'integer',
            references: '"menu"',
            onDelete: 'CASCADE',
        },
    });
};
