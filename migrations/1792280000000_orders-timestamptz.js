// orders.created_at / updated_at → timestamptz (review 2026-10-19, M6). As "timestamp without time zone"
// they held the wall-clock time of the DB session that wrote them — UTC in production, Asia/Jakarta on
// local copies — and the frontend read them as local time, so "Dibuat" showed the previous day for
// orders placed 00:00–06:59 WIB. Existing values are converted with the DB's own TimeZone setting, i.e.
// the zone they were written in; afterwards pg returns real instants (ISO with offset).
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE orders
            ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE current_setting('TimeZone'),
            ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE current_setting('TimeZone')
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE orders
            ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE current_setting('TimeZone'),
            ALTER COLUMN updated_at TYPE timestamp USING updated_at AT TIME ZONE current_setting('TimeZone')
    `);
};
