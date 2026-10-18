import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { pool } from '../config/db';
import { PAGES, ROLES, SESSION_TOUCH_MS, SESSION_TTL_MS, hasAllPages, type Role } from '../config/auth';
import { AppError, NotFoundError } from '../utils/errors';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../utils/password';

export interface SessionUser {
    id: string;
    email: string;
    role: Role;
    allowed_pages: string[];
}

/** What GET /auth/me and POST /auth/login return (same shape the old GET /user-role had). */
export const toProfile = (user: SessionUser) => ({
    user_id: user.id,
    email: user.email,
    role: user.role,
    allowed_pages: hasAllPages(user.role) ? [...PAGES] : user.allowed_pages,
});

const hashToken = (token: string) => createHash('sha256').update(token).digest();

const normalizeEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

// A wrong email costs as much time as a wrong password, so login timing doesn't reveal accounts.
let dummyHash: Promise<string> | undefined;

export class InvalidCredentialsError extends AppError {
    constructor() {
        super(401, 'Email atau password salah');
    }
}

export interface SessionMeta {
    userAgent?: string;
    ip?: string;
}

/** Checks the password and opens a session. Returns the raw token (for the cookie) and the user. */
export const login = async (emailInput: unknown, password: unknown, meta: SessionMeta = {}) => {
    const email = normalizeEmail(emailInput);
    if (!email || typeof password !== 'string' || !password) throw new InvalidCredentialsError();

    const { rows: [row] } = await pool.query(
        'SELECT id, email, role, allowed_pages, password_hash, is_active FROM users WHERE email = $1', [email]);
    if (!row) {
        await verifyPassword(password, await (dummyHash ??= hashPassword(randomBytes(16).toString('hex'))));
        throw new InvalidCredentialsError();
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok || !row.is_active) throw new InvalidCredentialsError();

    const token = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
         VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, $5)`,
        [hashToken(token), row.id, SESSION_TTL_MS, meta.userAgent?.slice(0, 500) ?? null, meta.ip && isIP(meta.ip) ? meta.ip : null]);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);

    const user: SessionUser = { id: row.id, email: row.email, role: row.role, allowed_pages: row.allowed_pages };
    return { token, user };
};

/**
 * The user behind a session token, or null (unknown, expired, user disabled). `refreshed` is true
 * when the expiry was just slid forward — the caller then re-sends the cookie with a fresh max-age.
 */
export const getSessionUser = async (token: string): Promise<{ user: SessionUser; refreshed: boolean } | null> => {
    if (!token) return null;
    const { rows: [row] } = await pool.query(
        `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.role, u.allowed_pages
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
        [hashToken(token)]);
    if (!row) return null;

    let refreshed = false;
    if (Date.now() - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_MS) {
        await pool.query(
            `UPDATE sessions SET last_seen_at = now(), expires_at = now() + $2 * interval '1 millisecond' WHERE id = $1`,
            [row.session_id, SESSION_TTL_MS]);
        refreshed = true;
    }
    return { user: { id: row.id, email: row.email, role: row.role, allowed_pages: row.allowed_pages }, refreshed };
};

export const logout = async (token: string) => {
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
};

// --- User management (CLI: src/cli/user.ts) ----------------------------------------------------

const assertRole = (role: string): Role => {
    if (!(ROLES as readonly string[]).includes(role)) throw new AppError(400, `Role harus salah satu dari: ${ROLES.join(', ')}`);
    return role as Role;
};

const assertPages = (pages: string[]) => {
    const unknown = pages.filter(p => !(PAGES as readonly string[]).includes(p));
    if (unknown.length) throw new AppError(400, `Halaman tidak dikenal: ${unknown.join(', ')}`);
    return [...new Set(pages)];
};

const assertPassword = (password: string) => {
    if (password.length < MIN_PASSWORD_LENGTH) throw new AppError(400, `Password minimal ${MIN_PASSWORD_LENGTH} karakter`);
};

export const createUser = async (input: { email: string; password: string; role: string; allowed_pages?: string[] }) => {
    const email = normalizeEmail(input.email);
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AppError(400, 'Email tidak valid');
    assertPassword(input.password);
    const { rows: [row] } = await pool.query(
        `INSERT INTO users (email, password_hash, role, allowed_pages) VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, allowed_pages, is_active`,
        [email, await hashPassword(input.password), assertRole(input.role), assertPages(input.allowed_pages ?? ['orders'])]);
    return row;
};

const updateByEmail = async (email: string, set: string, params: unknown[]) => {
    const { rows: [row] } = await pool.query(
        `UPDATE users SET ${set}, updated_at = now() WHERE email = $1 RETURNING id, email, role, allowed_pages, is_active`,
        [normalizeEmail(email), ...params]);
    if (!row) throw new NotFoundError('User tidak ditemukan');
    return row;
};

/** New password; also signs the user out everywhere and re-activates a disabled account. */
export const resetPassword = async (email: string, password: string) => {
    assertPassword(password);
    const row = await updateByEmail(email, 'password_hash = $2, is_active = true', [await hashPassword(password)]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
    return row;
};

/**
 * The logged-in user picks their own password (e.g. after an admin reset). Needs the current one;
 * every other session of the user is signed out, the one making the change stays logged in.
 * A wrong current password is a 400, not a 401: a 401 would send the frontend back to /login.
 */
export const changePassword = async (userId: string, sessionToken: string, currentPassword: unknown, newPassword: unknown) => {
    if (typeof currentPassword !== 'string' || !currentPassword) throw new AppError(400, 'Password lama wajib diisi');
    if (typeof newPassword !== 'string') throw new AppError(400, 'Password baru wajib diisi');
    assertPassword(newPassword);
    if (newPassword === currentPassword) throw new AppError(400, 'Password baru harus berbeda dari password lama');

    const { rows: [row] } = await pool.query('SELECT password_hash FROM users WHERE id = $1 AND is_active', [userId]);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw new AppError(400, 'Password lama salah');

    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(newPassword)]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, hashToken(sessionToken)]);
};

export const setUserActive = async (email: string, active: boolean) => {
    const row = await updateByEmail(email, 'is_active = $2', [active]);
    if (!active) await pool.query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
    return row;
};

export const setUserAccess = async (email: string, role: string, pages?: string[]) =>
    pages
        ? updateByEmail(email, 'role = $2, allowed_pages = $3', [assertRole(role), assertPages(pages)])
        : updateByEmail(email, 'role = $2', [assertRole(role)]);

export const listUsers = async () =>
    (await pool.query('SELECT email, role, allowed_pages, is_active, last_login_at FROM users ORDER BY email')).rows;
