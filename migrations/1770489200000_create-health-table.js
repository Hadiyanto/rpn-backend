exports.up = (pgm) => {
    pgm.sql(`
    CREATE TABLE IF NOT EXISTS health (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL
    )
  `);
};

exports.down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS health`);
};
