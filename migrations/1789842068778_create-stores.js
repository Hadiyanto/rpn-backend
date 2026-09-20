exports.up = (pgm) => {
    pgm.createTable('stores', {
        id: 'id',
        name: { type: 'varchar(255)', notNull: true },
        address: { type: 'text' },
        area_id: { type: 'varchar(100)' },
        latitude: { type: 'numeric(10,7)' },
        longitude: { type: 'numeric(10,7)' },
        phone: { type: 'varchar(50)' },
        is_active: { type: 'boolean', notNull: true, default: true },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
        updated_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // Store 1 = existing RPN origin (was hardcoded in biteship.route.ts / order.route.ts)
    pgm.sql(`
        INSERT INTO stores (name, address, area_id, latitude, longitude, phone)
        VALUES (
            'RPN Store Pancoran',
            'Belakang TK Widiastuti, Jalan Rawa Jati Timur VIII, RW 08, Rawajati, Pancoran, Jakarta Selatan, DKI Jakarta 12750',
            'IDNP6IDNC148IDND841IDZ12750',
            -6.261204,
            106.854106,
            '081314220599'
        )
    `);

    // Store 2 = Depok — MOCK placeholder. Update via PUT /stores/:id once real address/coordinates/area_id are available.
    pgm.sql(`
        INSERT INTO stores (name, address, area_id, latitude, longitude, phone)
        VALUES (
            'RPN Store Depok',
            'Alamat belum diisi (mock) - Depok, Jawa Barat',
            NULL,
            -6.402484,
            106.794243,
            NULL
        )
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('stores');
};
