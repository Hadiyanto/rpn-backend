exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('orders', {
        delivery_method: {
            type: 'varchar(30)',
            default: "'pickup'",
        },
        delivery_lat: {
            type: 'numeric(10, 7)',
        },
        delivery_lng: {
            type: 'numeric(10, 7)',
        },
        delivery_address: {
            type: 'text',
        },
        delivery_driver_note: {
            type: 'text',
        },
        delivery_area_id: {
            type: 'varchar(100)',
        },
        biteship_order_id: {
            type: 'varchar(100)',
        },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', [
        'delivery_method',
        'delivery_lat',
        'delivery_lng',
        'delivery_address',
        'delivery_driver_note',
        'delivery_area_id',
        'biteship_order_id',
    ]);
};
