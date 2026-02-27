exports.up = (pgm) => {
    pgm.addColumn('orders', {
        transfer_img_url: { type: 'text', notNull: false },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('orders', 'transfer_img_url');
};
