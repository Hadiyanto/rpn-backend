// HAMPERS is no longer sold. Drop its quota columns and deactivate the menu row.
// order_items_box_type_check still allows 'HAMPERS' so historical orders stay valid;
// the backend rejects new HAMPERS items.
exports.up = (pgm) => {
    pgm.dropColumns('daily_quota', ['hampers_qty']);
    pgm.dropColumns('hourly_quota', ['hampers_qty']);
    pgm.sql("UPDATE menu SET is_active = false WHERE name = 'HAMPERS'");
};

exports.down = (pgm) => {
    pgm.addColumns('daily_quota', { hampers_qty: { type: 'integer', notNull: true, default: 0 } });
    pgm.addColumns('hourly_quota', { hampers_qty: { type: 'integer', notNull: true, default: 0 } });
    pgm.sql("UPDATE menu SET is_active = true WHERE name = 'HAMPERS'");
};
