exports.up = (pgm) => {
    pgm.sql(`
    INSERT INTO health (id, status) VALUES (1, 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `);
};

exports.down = (pgm) => {
    pgm.sql(`DELETE FROM health WHERE id = 1`);
};
