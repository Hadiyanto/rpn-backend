// Official Google Maps link of a store (its business listing), for WhatsApp messages and the
// storefront. Empty → a link built from the store's coordinates.
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('stores', { maps_url: { type: 'text' } });
};

exports.down = (pgm) => {
    pgm.dropColumns('stores', ['maps_url']);
};
