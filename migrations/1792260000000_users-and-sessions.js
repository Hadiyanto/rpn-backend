// Own login instead of Supabase Auth (docs/plan-lepas-vendor.md §4): admin users + revocable
// server-side sessions. The admins in user_roles are copied with the same id; they get no usable
// password ('!' never matches a scrypt hash) until one is set with `node dist/cli/user.js reset-password`.
// user_roles stays until Supabase is dropped (Rilis 3).
exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.createTable('users', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        email: { type: 'text', notNull: true, unique: true },               // stored lowercase
        password_hash: { type: 'text', notNull: true },
        role: { type: 'varchar(50)', notNull: true, default: 'employee' },  // superadmin | owner | employee
        allowed_pages: { type: 'text[]', notNull: true, default: pgm.func("'{orders}'") },
        is_active: { type: 'boolean', notNull: true, default: true },
        last_login_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.addConstraint('users', 'users_email_lowercase', { check: 'email = lower(email)' });
    pgm.addConstraint('users', 'users_role_check', { check: "role IN ('superadmin', 'owner', 'employee')" });

    pgm.createTable('sessions', {
        id: 'bigserial primary key',
        token_hash: { type: 'bytea', notNull: true, unique: true },         // sha256(token); the token lives only in the cookie
        user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
        expires_at: { type: 'timestamptz', notNull: true },
        last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        user_agent: { type: 'text' },
        ip: { type: 'inet' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.createIndex('sessions', 'user_id');
    pgm.createIndex('sessions', 'expires_at');

    pgm.sql(`
        INSERT INTO users (id, email, password_hash, role, allowed_pages)
        SELECT user_id, lower(email), '!',
               CASE WHEN lower(role) = 'admin' THEN 'superadmin' ELSE 'employee' END,
               ARRAY(SELECT DISTINCT unnest(allowed_pages))
        FROM user_roles
        WHERE email IS NOT NULL AND email <> ''
        ON CONFLICT (email) DO NOTHING
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('sessions');
    pgm.dropTable('users');
};
