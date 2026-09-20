exports.up = (pgm) => {
    pgm.addColumns('stores', {
        open_time: { type: 'varchar(5)', notNull: true, default: '11:00' },
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('stores', ['open_time']);
};
