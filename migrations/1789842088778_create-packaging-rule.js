// "Kemasan & perlengkapan": counted items (pcs) used per order, per store (docs/plan-stok-kemasan.md).
// Items live in `stock`; this table only says how many are used:
//   per_box   qty × number of boxes (of box_type, or all boxes when NULL)
//   per_boxes qty × ceil(boxes / boxes_per_unit)  e.g. 1 plastic bag per 2 boxes
//   per_order qty once per order that has boxes
exports.up = (pgm) => {
    pgm.createTable('packaging_rule', {
        id: { type: 'serial', primaryKey: true },
        store_id: { type: 'integer', notNull: true, references: 'stores', onDelete: 'CASCADE' },
        stock_id: { type: 'integer', notNull: true, references: 'stock', onDelete: 'CASCADE' },
        box_type: { type: 'varchar(10)' },
        mode: { type: 'varchar(12)', notNull: true },
        qty: { type: 'numeric(10,2)', notNull: true },
        boxes_per_unit: { type: 'integer' },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('packaging_rule', 'packaging_rule_mode_check', { check: "mode IN ('per_box', 'per_boxes', 'per_order')" });
    pgm.addConstraint('packaging_rule', 'packaging_rule_box_type_check', { check: "box_type IS NULL OR box_type IN ('FULL', 'HALF')" });
    pgm.addConstraint('packaging_rule', 'packaging_rule_qty_check', { check: 'qty > 0' });
    pgm.addConstraint('packaging_rule', 'packaging_rule_boxes_per_unit_check', {
        check: "(mode = 'per_boxes' AND boxes_per_unit >= 2) OR (mode <> 'per_boxes' AND boxes_per_unit IS NULL)",
    });
    // NULL box_type means "all boxes", so it must be unique too.
    pgm.sql(`CREATE UNIQUE INDEX packaging_rule_unique ON packaging_rule (store_id, stock_id, COALESCE(box_type, ''), mode)`);

    // Default packaging for every store: create the items (stock 0, pcs) when missing, then the rules.
    pgm.sql(`
        WITH defaults(item_name, box_type, mode, qty, boxes_per_unit) AS (VALUES
            ('Box Besar',      'FULL', 'per_box',   1, NULL::int),
            ('Box Kecil',      'HALF', 'per_box',   1, NULL),
            ('Garpu',          NULL,   'per_box',   1, NULL),
            ('Plastik Kuning', NULL,   'per_boxes', 1, 2),
            ('Sticker',        NULL,   'per_order', 1, NULL)
        ),
        missing AS (
            INSERT INTO stock (item_name, unit, qty, store_id)
            SELECT d.item_name, 'pcs', 0, s.id
            FROM defaults d CROSS JOIN stores s
            WHERE NOT EXISTS (SELECT 1 FROM stock st WHERE st.store_id = s.id AND lower(trim(st.item_name)) = lower(d.item_name))
            RETURNING id, item_name, store_id
        ),
        items AS (
            SELECT id, item_name, store_id FROM missing
            UNION ALL
            SELECT st.id, st.item_name, st.store_id FROM stock st
            WHERE lower(trim(st.item_name)) IN (SELECT lower(item_name) FROM defaults)
        )
        INSERT INTO packaging_rule (store_id, stock_id, box_type, mode, qty, boxes_per_unit)
        SELECT DISTINCT ON (i.store_id, d.item_name) i.store_id, i.id, d.box_type, d.mode, d.qty, d.boxes_per_unit
        FROM defaults d JOIN items i ON lower(trim(i.item_name)) = lower(d.item_name)
        ORDER BY i.store_id, d.item_name, i.id
    `);
};

exports.down = (pgm) => {
    // Seeded stock items are kept (they may have history by now).
    pgm.dropTable('packaging_rule');
};
