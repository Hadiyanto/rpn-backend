// Store delivery (STORE_DELIVERY=true): the shipping fee is quoted by the backend when the order is
// created and charged on top of the items (DOKU). The courier it was quoted for is the one dispatched.
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.addColumns('orders', {
        delivery_fee: { type: 'numeric(12,2)' },
        delivery_courier_company: { type: 'varchar(50)' },
        delivery_courier_type: { type: 'varchar(50)' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['delivery_fee', 'delivery_courier_company', 'delivery_courier_type']);
};
