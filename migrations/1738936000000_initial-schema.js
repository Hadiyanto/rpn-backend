exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. Menu Table (Master Data)
    pgm.createTable('menu', {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'varchar(255)', notNull: true },
        description: { type: 'text' },
        category: { type: 'varchar(100)' }, // e.g., 'Makanan', 'Minuman'
        image_url: { type: 'text' },
        is_active: { type: 'boolean', default: true },
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

    // 2. Variant Table (Menu Options)
    pgm.createTable('variant', {
        id: { type: 'serial', primaryKey: true },
        menu_id: {
            type: 'integer',
            notNull: true,
            references: '"menu"',
            onDelete: 'CASCADE',
        },
        variant_name: { type: 'varchar(255)', notNull: true },
        price: { type: 'decimal(12, 2)', notNull: true },
        is_active: { type: 'boolean', default: true },
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

    // 3. Stock Table (Inventory)
    pgm.createTable('stock', {
        id: { type: 'serial', primaryKey: true },
        item_name: { type: 'varchar(255)', notNull: true },
        qty: { type: 'decimal(10, 2)', notNull: true, default: 0 },
        unit: { type: 'varchar(50)' }, // e.g., 'kg', 'pcs'
        updated_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // 4. Transactions Table (Header for Sales)
    pgm.createTable('transactions', {
        id: { type: 'serial', primaryKey: true },
        date: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
        total_amount: { type: 'decimal(12, 2)', default: 0 },
        payment_method: { type: 'varchar(50)' }, // e.g., 'Cash', 'QRIS'
        receipt_image_url: { type: 'text' },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // 5. Penjualan Table (Sales Items)
    pgm.createTable('penjualan', {
        id: { type: 'serial', primaryKey: true },
        transaction_id: {
            type: 'integer',
            references: '"transactions"',
            onDelete: 'CASCADE',
        },
        menu_id: {
            type: 'integer',
            references: '"menu"',
            onDelete: 'SET NULL',
        },
        variant_id: {
            type: 'integer',
            references: '"variant"',
            onDelete: 'SET NULL',
        },
        quantity: { type: 'integer', notNull: true },
        price: { type: 'decimal(12, 2)', notNull: true }, // Price at time of sale
        total_price: { type: 'decimal(12, 2)', notNull: true },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    // 6. Pengeluaran Table (Expenses)
    pgm.createTable('pengeluaran', {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'varchar(255)', notNull: true },
        category: { type: 'varchar(100)' }, // e.g., 'Bahan Baku', 'Gaji'
        price: { type: 'decimal(12, 2)', notNull: true },
        date: { type: 'date', notNull: true, default: pgm.func('current_date') },
        receipt_image_url: { type: 'text' },
        created_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable('pengeluaran');
    pgm.dropTable('penjualan');
    pgm.dropTable('transactions');
    pgm.dropTable('stock');
    pgm.dropTable('variant');
    pgm.dropTable('menu');
};
