import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, allowedOrigins, getAuthMode, hasAllPages, sessionCookieOptions, SESSION_TTL_MS, type Page } from '../config/auth';
import { getSessionUser, type SessionUser } from '../services/auth.service';
import { parseCookies } from '../utils/cookies';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: SessionUser;
            sessionToken?: string;
        }
    }
}

// Paths are relative to /api (these middlewares are mounted in routes/index.ts).
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Endpoints the customer pages and third-party webhooks use without a login. */
export const PUBLIC_ROUTES: Array<[Method, RegExp]> = [
    ['POST', /^\/auth\/(login|logout)$/],
    ['GET', /^\/auth\/me$/],                           // answers 401 itself
    ['GET', /^\/stores(\/\d+)?$/],
    ['GET', /^\/menu$/],
    ['GET', /^\/variants(\/best-sellers)?$/],
    ['GET', /^\/daily-quota$/],
    ['GET', /^\/hourly-quota\/availability$/],
    ['POST', /^\/orders\/quote$/],
    ['POST', /^\/order$/],                             // the admin order form also posts here
    ['GET', /^\/payment\/config$/],
    ['POST', /^\/biteship\/(eligibility|store-delivery-options)$/],
    ['GET', /^\/biteship\/areas$/],
    ['POST', /^\/biteship\/webhook$/],
    ['GET', /^\/order\/public\/[^/]+$/],
    ['PATCH', /^\/order\/public\/[^/]+\/transfer-img-url$/],
    ['POST', /^\/order\/public\/[^/]+\/doku-sync$/],
    ['POST', /^\/upload-image$/],                      // transfer proofs; size/type limited in the route
    ['POST', /^\/payments\/doku\/notification$/],      // DOKU signature
    ['GET', /^\/push\/vapid-public-key$/],             // a public key
];

const ANY: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const WRITE: Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Which pages may call an endpoint (first match wins). Endpoints without a rule only need a login.
 * Mirrors what each admin page fetches; superadmin/owner pass every rule.
 */
export const PAGE_RULES: Array<{ methods: Method[]; path: RegExp; pages: Page[] }> = [
    { methods: ['POST'], path: /^\/whatsapp\/send$/, pages: ['orders', 'config'] },
    { methods: ANY, path: /^\/whatsapp\//, pages: ['config'] },
    { methods: ANY, path: /^\/daily-salary(\/|$)/, pages: ['salary'] },
    { methods: ['GET'], path: /^\/salary-config$/, pages: ['salary', 'config'] },
    { methods: WRITE, path: /^\/salary-config(\/|$)/, pages: ['config'] },
    { methods: ANY, path: /^\/(capital|debt)(\/|$)/, pages: ['finance'] },
    { methods: ANY, path: /^\/finance\//, pages: ['summary', 'finance'] },
    { methods: ['GET'], path: /^\/pengeluaran$/, pages: ['cashflow', 'finance', 'summary'] },
    { methods: ANY, path: /^\/stocks(\/|$)/, pages: ['stock', 'config'] },
    { methods: ANY, path: /^\/biteship\/(order|rates)(\/|$)/, pages: ['shipping'] },
    { methods: ANY, path: /^\/(setup-status|variant-hpp|variant-recipe|base-recipe|packaging-rule|variant-price)(\/|$)/, pages: ['config'] },
    { methods: WRITE, path: /^\/(menu|variants|daily-quota|hourly-quota|stores)(\/|$)/, pages: ['config'] },
    { methods: ['GET'], path: /^\/(orders|order\/\d+)$/, pages: ['orders', 'sales', 'analytics', 'cashflow', 'finance'] },
    { methods: WRITE, path: /^\/order\/\d+(\/|$)/, pages: ['orders'] },
    { methods: ANY, path: /^\/(transaction|transactions|penjualan)(\/|$)/, pages: ['sales'] },
];

export const isPublicRoute = (method: string, path: string) =>
    PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path));

export const requiredPages = (method: string, path: string): Page[] | null =>
    PAGE_RULES.find(r => (r.methods as string[]).includes(method) && r.path.test(path))?.pages ?? null;

export const canAccess = (user: Pick<SessionUser, 'role' | 'allowed_pages'>, pages: Page[]) =>
    hasAllPages(user.role) || pages.some(p => user.allowed_pages.includes(p));

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const requestOrigin = (req: Request) => {
    const origin = req.header('origin');
    if (origin) return origin;
    const referer = req.header('referer');
    try {
        return referer ? new URL(referer).origin : undefined;
    } catch {
        return undefined;
    }
};

/**
 * CSRF guard: a write that carries the session cookie must come from our own frontend. The cookie
 * is SameSite=Lax, but every *.rajapisangnugget.com host counts as same-site, so the Origin is checked too.
 */
export const csrfGuard = (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || !parseCookies(req.header('cookie'))[SESSION_COOKIE]) {
        next();
        return;
    }
    const origin = requestOrigin(req);
    if (!origin || !allowedOrigins().includes(origin)) {
        console.warn(`[auth] CSRF blocked ${req.method} ${req.originalUrl} origin=${origin ?? '-'}`);
        res.status(403).json({ status: 'error', message: 'Origin tidak diizinkan' });
        return;
    }
    next();
};

/** Reads the session cookie into req.user. A stale cookie is cleared so the frontend stops redirecting on it. */
export const loadSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = parseCookies(req.header('cookie'))[SESSION_COOKIE];
        if (token) {
            const session = await getSessionUser(token);
            if (session) {
                req.user = session.user;
                req.sessionToken = token;
                if (session.refreshed) res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: SESSION_TTL_MS });
            } else {
                res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
            }
        }
        next();
    } catch (err) {
        next(err);
    }
};

/** Login + page permission for every non-public route, per AUTH_MODE. */
export const authorize = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS' || isPublicRoute(req.method, req.path)) {
        next();
        return;
    }
    const mode = getAuthMode();
    if (mode === 'off') {
        next();
        return;
    }

    let status: 401 | 403 | undefined;
    let pages: Page[] | null = null;
    if (!req.user) {
        status = 401;
    } else {
        pages = requiredPages(req.method, req.path);
        if (pages && !canAccess(req.user, pages)) status = 403;
    }
    if (!status) {
        next();
        return;
    }
    if (mode === 'log') {
        console.warn(`[auth] would ${status} ${req.method} ${req.originalUrl}${req.user ? ` user=${req.user.email} needs=${pages?.join('|')}` : ''}`);
        next();
        return;
    }
    res.status(status).json(status === 401
        ? { status: 'error', message: 'Login diperlukan' }
        : { status: 'error', message: 'Anda tidak punya akses ke halaman ini' });
};
