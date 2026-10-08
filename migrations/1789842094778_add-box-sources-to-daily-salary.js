// Daily salary can count boxes from several stores (e.g. one team serving Kalibata + Depok).
// box_sources = [{ store_id, store_name, boxes }] that made up total_boxes; existing rows counted
// only their own store.
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('daily_salary', {
        box_sources: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('daily_salary', ['box_sources']);
};
