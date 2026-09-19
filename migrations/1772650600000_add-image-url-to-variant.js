exports.shorthands = undefined;

// Frontend now renders a thumbnail per flavor variant using `image_url`
// (see rpn-frontend types/menu.ts), matching the column name already used
// on the `menu` table. `variant` had no image column at all until now.
exports.up = (pgm) => {
    pgm.addColumns('variant', {
        image_url: { type: 'text' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('variant', ['image_url']);
};
