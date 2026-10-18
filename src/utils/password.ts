import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashes: "scrypt$N$r$p$salt$hash" (salt and hash base64), node:crypto only.
const N = 16384, R = 8, P = 1, KEY_LEN = 64;

const derive = (password: string, salt: Buffer, opts: ScryptOptions) =>
    new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, KEY_LEN, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)));

export const hashPassword = async (password: string): Promise<string> => {
    const salt = randomBytes(16);
    const hash = await derive(password, salt, { N, r: R, p: P });
    return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
};

/** False for a wrong password and for any stored value that isn't a scrypt hash (e.g. '!'). */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [n, r, p] = parts.slice(1, 4).map(Number);
    if (![n, r, p].every(Number.isInteger)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const actual = await derive(password, salt, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Random password for new users / resets: 16 chars, no look-alike characters. */
export const generatePassword = (length = 16) => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(length);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
};

export const MIN_PASSWORD_LENGTH = 10;
