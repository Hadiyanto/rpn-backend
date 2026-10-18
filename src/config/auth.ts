import type { CookieOptions } from 'express';

/**
 * Rollout switch for the API lock (docs/plan-lepas-vendor.md §4.2):
 *   off     — sessions are read, nothing is blocked
 *   log     — requests that would be blocked are logged and still served
 *   enforce — 401/403 for admin routes without a (permitted) session (default)
 */
export type AuthMode = 'off' | 'log' | 'enforce';

export const getAuthMode = (): AuthMode => {
    const mode = (process.env.AUTH_MODE ?? '').trim().toLowerCase();
    return mode === 'off' || mode === 'log' ? mode : 'enforce';
};

export const SESSION_COOKIE = 'rpn_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session's expiry slides forward at most this often (one UPDATE per hour, not per request). */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/**
 * AUTH_COOKIE_DOMAIN=.rajapisangnugget.com lets the frontend's middleware see the cookie the API
 * (api.rajapisangnugget.com) sets. Unset = host-only (localhost: ports share cookies anyway).
 * AUTH_COOKIE_SECURE=false only for plain-http local runs (Safari drops Secure cookies on http).
 */
export const sessionCookieOptions = (): CookieOptions => ({
    httpOnly: true,
    secure: process.env.AUTH_COOKIE_SECURE !== 'false',
    sameSite: 'lax',
    path: '/',
    ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
});

/** Admin pages; a user's allowed_pages is a subset of these. */
export const PAGES = ['orders', 'sales', 'analytics', 'stock', 'shipping', 'salary', 'finance', 'cashflow', 'summary', 'config'] as const;
export type Page = typeof PAGES[number];

export const ROLES = ['superadmin', 'owner', 'employee'] as const;
export type Role = typeof ROLES[number];

/** superadmin and owner see every page; employees only their allowed_pages. */
export const hasAllPages = (role: string) => role === 'superadmin' || role === 'owner';

/** Origins allowed to send cookie-authenticated writes (same list as CORS). */
export const allowedOrigins = () =>
    (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim()).filter(Boolean);
