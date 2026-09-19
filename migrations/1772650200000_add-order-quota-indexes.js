exports.shorthands = undefined;

exports.up = (pgm) => {
    // Speeds up the quota "used" aggregate queries in dailyQuota/hourlyQuota/order
    // services, which filter by pickup_date (+ pickup_time) and join order_items.
    pgm.createIndex('orders', ['pickup_date', 'pickup_time']);
    // order_items.order_id is a foreign key but Postgres does not auto-index FK columns.
    pgm.createIndex('order_items', 'order_id');
};

exports.down = (pgm) => {
    pgm.dropIndex('order_items', 'order_id');
    pgm.dropIndex('orders', ['pickup_date', 'pickup_time']);
};
