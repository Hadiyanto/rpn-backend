import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { authorize, canAccess, csrfGuard, isPublicRoute, requiredPages } from '../auth';
import { parseCookies } from '../../utils/cookies';
import { hashPassword, verifyPassword } from '../../utils/password';

const fakeRes = () => {
    const res = { statusCode: 200, body: undefined as unknown } as Response & { body: unknown };
    res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as any;
    res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as any;
    return res;
};

const fakeReq = (method: string, path: string, opts: { headers?: Record<string, string>; user?: Request['user'] } = {}) => {
    const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { method, path, originalUrl: `/api${path}`, user: opts.user, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
};

const run = (mw: (req: Request, res: Response, next: NextFunction) => void, req: Request) => {
    const res = fakeRes();
    const next = vi.fn();
    mw(req, res, next);
    return { res, next };
};

const employee = (pages: string[]) => ({ id: 'u1', email: 'staff@rpn.test', role: 'employee' as const, allowed_pages: pages });

describe('public routes', () => {
    it.each([
        ['GET', '/stores'], ['GET', '/stores/2'], ['GET', '/menu'], ['GET', '/variants/best-sellers'],
        ['POST', '/order'], ['POST', '/orders/quote'], ['GET', '/order/public/abc123'],
        ['PATCH', '/order/public/abc123/transfer-img-url'], ['POST', '/payments/doku/notification'],
        ['POST', '/biteship/webhook'], ['POST', '/auth/login'], ['GET', '/auth/me'],
    ])('%s %s is public', (method, path) => {
        expect(isPublicRoute(method, path)).toBe(true);
    });

    it.each([
        ['GET', '/orders'], ['GET', '/order/12'], ['PUT', '/stores/1'], ['POST', '/whatsapp/send'],
        ['GET', '/whatsapp/qr'], ['POST', '/menu'], ['GET', '/user-role/x'], ['GET', '/stores/1/../../orders'],
    ])('%s %s needs a login', (method, path) => {
        expect(isPublicRoute(method, path)).toBe(false);
    });
});

describe('page rules', () => {
    it('maps endpoints to the pages that use them', () => {
        expect(requiredPages('POST', '/whatsapp/send')).toEqual(['orders', 'config']);
        expect(requiredPages('POST', '/whatsapp/regenerate')).toEqual(['config']);
        expect(requiredPages('GET', '/salary-config')).toEqual(['salary', 'config']);
        expect(requiredPages('PUT', '/salary-config')).toEqual(['config']);
        expect(requiredPages('PUT', '/stores/1')).toEqual(['config']);
        expect(requiredPages('GET', '/orders')).toContain('sales');
        expect(requiredPages('PATCH', '/order/5/status')).toEqual(['orders']);
        expect(requiredPages('POST', '/pengeluaran')).toBeNull(); // expenses form: any login
    });

    it('superadmin/owner pass every rule, employees only their pages', () => {
        expect(canAccess({ role: 'owner', allowed_pages: [] }, ['salary'])).toBe(true);
        expect(canAccess({ role: 'superadmin', allowed_pages: [] }, ['config'])).toBe(true);
        expect(canAccess(employee(['orders']), ['orders', 'config'])).toBe(true);
        expect(canAccess(employee(['orders']), ['salary'])).toBe(false);
    });
});

describe('authorize per AUTH_MODE', () => {
    afterEach(() => { delete process.env.AUTH_MODE; vi.restoreAllMocks(); });

    it('enforce (default): 401 without session, 403 without the page, next() otherwise', () => {
        expect(run(authorize, fakeReq('GET', '/orders')).res.statusCode).toBe(401);
        expect(run(authorize, fakeReq('GET', '/daily-salary', { user: employee(['orders']) })).res.statusCode).toBe(403);
        expect(run(authorize, fakeReq('GET', '/orders', { user: employee(['orders']) })).next).toHaveBeenCalled();
        expect(run(authorize, fakeReq('GET', '/menu')).next).toHaveBeenCalled();
    });

    it('log: serves the request and logs it', () => {
        process.env.AUTH_MODE = 'log';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { res, next } = run(authorize, fakeReq('GET', '/orders'));
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('would 401 GET /api/orders'));
    });

    it('off: everything passes', () => {
        process.env.AUTH_MODE = 'off';
        expect(run(authorize, fakeReq('POST', '/whatsapp/send')).next).toHaveBeenCalled();
    });
});

describe('csrfGuard', () => {
    afterEach(() => { delete process.env.CORS_ORIGINS; vi.restoreAllMocks(); });
    const cookie = { cookie: 'rpn_session=abc' };

    it('lets reads and cookie-less writes through', () => {
        expect(run(csrfGuard, fakeReq('GET', '/orders', { headers: { ...cookie, origin: 'https://evil.test' } })).next).toHaveBeenCalled();
        expect(run(csrfGuard, fakeReq('POST', '/payments/doku/notification')).next).toHaveBeenCalled();
    });

    it('blocks cookie writes from a foreign or missing origin, allows our frontend', () => {
        process.env.CORS_ORIGINS = 'https://rajapisangnugget.com, http://localhost:3001';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(run(csrfGuard, fakeReq('POST', '/whatsapp/send', { headers: { ...cookie, origin: 'https://evil.test' } })).res.statusCode).toBe(403);
        expect(run(csrfGuard, fakeReq('POST', '/whatsapp/send', { headers: cookie })).res.statusCode).toBe(403);
        expect(run(csrfGuard, fakeReq('POST', '/x', { headers: { ...cookie, origin: 'https://rajapisangnugget.com' } })).next).toHaveBeenCalled();
        expect(run(csrfGuard, fakeReq('PUT', '/x', { headers: { ...cookie, referer: 'http://localhost:3001/config' } })).next).toHaveBeenCalled();
    });
});

describe('cookies & passwords', () => {
    it('parses a Cookie header', () => {
        expect(parseCookies('a=1; rpn_session=x%2By; a=2; bad')).toEqual({ a: '1', rpn_session: 'x+y' });
        expect(parseCookies(undefined)).toEqual({});
    });

    it('hashes with scrypt and verifies', async () => {
        const hash = await hashPassword('rahasia-banget');
        expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
        expect(await verifyPassword('rahasia-banget', hash)).toBe(true);
        expect(await verifyPassword('salah', hash)).toBe(false);
        expect(await verifyPassword('apa-saja', '!')).toBe(false); // migrated users without a password
    });
});
