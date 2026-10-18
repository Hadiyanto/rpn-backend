exports.up = (pgm) => {
    pgm.addColumn('stores', {
        is_open_for_orders: { type: 'boolean', notNull: true, default: true },
    });

    pgm.createTable('order_delivery_attempts', {
        id: 'id',
        order_id: { type: 'integer', notNull: true, references: 'orders(id)', onDelete: 'CASCADE' },
        attempt_no: { type: 'integer', notNull: true },
        status: { type: 'varchar(32)', notNull: true, default: 'PENDING' },
        biteship_order_id: { type: 'varchar(128)' },
        courier_company: { type: 'varchar(80)' },
        courier_type: { type: 'varchar(80)' },
        tracking_link: { type: 'text' },
        waybill_id: { type: 'varchar(128)' },
        driver_name: { type: 'varchar(255)' },
        driver_phone: { type: 'varchar(80)' },
        driver_plate_number: { type: 'varchar(80)' },
        failure_code: { type: 'varchar(128)' },
        failure_message: { type: 'text' },
        provider_status: { type: 'varchar(80)' },
        provider_updated_at: { type: 'timestamptz' },
        delivery_notified_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    });
    pgm.addConstraint('order_delivery_attempts', 'order_delivery_attempts_order_attempt_unique', { unique: ['order_id', 'attempt_no'] });
    pgm.createIndex('order_delivery_attempts', ['order_id', 'attempt_no']);
    pgm.createIndex('order_delivery_attempts', 'status');
    pgm.createIndex('order_delivery_attempts', 'biteship_order_id', { unique: true, where: 'biteship_order_id IS NOT NULL' });
    pgm.createIndex('order_delivery_attempts', 'order_id', {
        unique: true,
        name: 'one_active_delivery_attempt_per_order',
        where: "status IN ('PENDING', 'ALLOCATED')",
    });
    pgm.createTable('biteship_webhook_events', {
        id: 'id',
        event_hash: { type: 'varchar(64)', notNull: true, unique: true },
        event_name: { type: 'varchar(80)' },
        biteship_order_id: { type: 'varchar(128)' },
        received_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    });

    // Preserve current in-flight and completed shipments as the initial attempt history.
    pgm.sql(`
        INSERT INTO order_delivery_attempts (order_id, attempt_no, status, biteship_order_id, courier_company, courier_type, created_at, updated_at)
        SELECT id, 1,
            CASE WHEN biteship_order_id IN ('PENDING', 'UNKNOWN') THEN 'PENDING' ELSE 'ALLOCATED' END,
            CASE WHEN biteship_order_id IN ('PENDING', 'UNKNOWN') THEN NULL ELSE biteship_order_id END,
            delivery_courier_company, delivery_courier_type,
            COALESCE(updated_at, created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        FROM orders
        WHERE delivery_method = 'store_delivery' AND biteship_order_id IS NOT NULL
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('biteship_webhook_events');
    pgm.dropTable('order_delivery_attempts');
    pgm.dropColumn('stores', 'is_open_for_orders');
};
