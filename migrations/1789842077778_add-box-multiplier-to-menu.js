// box_multiplier: how much of a FULL-box recipe one box of this menu uses (HALF = 0.5).
// max_flavors: how many flavors a customer may mix in one box of this menu.
exports.up = (pgm) => {
    pgm.addColumns('menu', {
        box_multiplier: { type: 'numeric(4,2)', notNull: true, default: 1.0 },
        max_flavors: { type: 'smallint', notNull: true, default: 1 },
    });
    pgm.addConstraint('menu', 'menu_box_multiplier_check', { check: 'box_multiplier > 0' });
    pgm.addConstraint('menu', 'menu_max_flavors_check', { check: 'max_flavors BETWEEN 1 AND 10' });
    pgm.sql("UPDATE menu SET box_multiplier = 0.50, max_flavors = 1 WHERE name = 'HALF'");
    // K4 (2 vs 3) not decided yet — 3 matches what customers see on the public page today.
    pgm.sql("UPDATE menu SET box_multiplier = 1.00, max_flavors = 3 WHERE name = 'FULL'");
};

exports.down = (pgm) => {
    pgm.dropConstraint('menu', 'menu_max_flavors_check');
    pgm.dropConstraint('menu', 'menu_box_multiplier_check');
    pgm.dropColumns('menu', ['box_multiplier', 'max_flavors']);
};
