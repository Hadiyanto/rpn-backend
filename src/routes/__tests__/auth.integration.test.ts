import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';

const ORIGIN = 'http://localhost:3001';

// Own login end to end over HTTP: /api router (csrf → session → authorize) on a local Postgres.
describe.skipIf(!hasTestDb)('auth (local Postgres, real HTTP)', () => {
    let db: typeof import('../../config/db');
    let auth: typeof import('../../services/auth.service');
    let server: Server;
    let base = '';

    beforeAll(async () => {
        useTestDb();
        process.env.CORS_ORIGINS = ORIGIN;
        process.env.AUTH_COOKIE_SECURE = 'false';
        delete process.env.AUTH_MODE;
        db = await import('../../config/db');
        auth = await import('../../services/auth.service');
        const express = (await import('express')).default;
        const apiRoutes = (await import('../index')).default;
        const app = express();
        app.use(express.json());
        app.use('/api', apiRoutes);
        server = app.listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });

    afterAll(async () => {
        server?.close();
        await db?.pool.query('TRUNCATE users CASCADE');
        await db?.pool.end();
    });

    beforeEach(async () => {
        await db.pool.query('TRUNCATE users CASCADE');
        await auth.createUser({ email: 'Owner@RPN.test', password: 'password-owner', role: 'owner' });
        await auth.createUser({ email: 'kasir@rpn.test', password: 'password-kasir', role: 'employee', allowed_pages: ['orders'] });
    });

    const api = (path: string, init: RequestInit & { cookie?: string } = {}) =>
        fetch(`${base}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                origin: ORIGIN,
                ...(init.cookie ? { cookie: init.cookie } : {}),
                ...(init.headers as Record<string, string> | undefined),
            },
        });

    const loginAs = async (email: string, password: string) => {
        const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        const setCookie = res.headers.get('set-cookie') ?? '';
        return { res, body: await res.json(), setCookie, cookie: setCookie.split(';')[0] };
    };

    it('login sets an HttpOnly session cookie and returns the profile; /auth/me reads it', async () => {
        const { res, body, setCookie, cookie } = await loginAs(' owner@rpn.test ', 'password-owner');
        expect(res.status).toBe(200);
        expect(setCookie).toMatch(/^rpn_session=[\w-]{40,};/);
        expect(setCookie).toMatch(/HttpOnly/i);
        expect(setCookie).toMatch(/SameSite=Lax/i);
        expect(body.data).toMatchObject({ email: 'owner@rpn.test', role: 'owner' });
        expect(body.data.allowed_pages).toContain('salary'); // owner sees every page

        const me = await api('/auth/me', { cookie });
        expect(me.status).toBe(200);
        expect((await me.json()).data.email).toBe('owner@rpn.test');

        // Only the hash is stored.
        const { rows } = await db.pool.query('SELECT token_hash FROM sessions');
        expect(rows).toHaveLength(1);
        expect(rows[0].token_hash.toString('base64url')).not.toBe(cookie.split('=')[1]);
    });

    it('wrong password / unknown email / migrated user without password → same 401', async () => {
        await db.pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('lama@rpn.test', '!', 'superadmin')`);
        for (const [email, password] of [['owner@rpn.test', 'salah-salah'], ['siapa@rpn.test', 'password-owner'], ['lama@rpn.test', '!']]) {
            const { res, body } = await loginAs(email, password);
            expect(res.status).toBe(401);
            expect(body.message).toBe('Email atau password salah');
        }
    });

    it('admin routes: 401 without session, 403 without the page, 200 with it; public routes stay open', async () => {
        expect((await api('/orders')).status).toBe(401);
        expect((await api('/payment/config')).status).toBe(200);

        const { cookie } = await loginAs('kasir@rpn.test', 'password-kasir');
        expect((await api('/orders', { cookie })).status).toBe(200);
        expect((await api('/daily-salary', { cookie })).status).toBe(403);
        expect((await api('/whatsapp/regenerate', { method: 'POST', cookie })).status).toBe(403);
    });

    it('CSRF: a cookie write from another origin is refused', async () => {
        const { cookie } = await loginAs('owner@rpn.test', 'password-owner');
        const res = await api('/auth/logout', { method: 'POST', cookie, headers: { origin: 'https://evil.test' } });
        expect(res.status).toBe(403);
        expect((await api('/auth/me', { cookie })).status).toBe(200); // still logged in
    });

    it('logout revokes the session and clears the cookie; a stale cookie is cleared on the next call', async () => {
        const { cookie } = await loginAs('owner@rpn.test', 'password-owner');
        const out = await api('/auth/logout', { method: 'POST', cookie });
        expect(out.status).toBe(200);
        expect(out.headers.get('set-cookie')).toMatch(/rpn_session=;.*Expires=Thu, 01 Jan 1970/i);

        const me = await api('/auth/me', { cookie });
        expect(me.status).toBe(401);
        expect(me.headers.get('set-cookie')).toMatch(/^rpn_session=;/);
    });

    it('expired sessions and disabled users are rejected; reset-password signs out everywhere', async () => {
        const { cookie } = await loginAs('kasir@rpn.test', 'password-kasir');
        await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
        expect((await api('/auth/me', { cookie })).status).toBe(401);

        const second = await loginAs('kasir@rpn.test', 'password-kasir');
        await auth.setUserActive('kasir@rpn.test', false);
        expect((await api('/auth/me', { cookie: second.cookie })).status).toBe(401);
        expect((await loginAs('kasir@rpn.test', 'password-kasir')).res.status).toBe(401);

        await auth.resetPassword('kasir@rpn.test', 'password-baru-123');
        expect((await loginAs('kasir@rpn.test', 'password-baru-123')).res.status).toBe(200);
    });

    it('slides the expiry forward (and re-sends the cookie) at most once an hour', async () => {
        const { cookie } = await loginAs('owner@rpn.test', 'password-owner');
        const fresh = await api('/auth/me', { cookie });
        expect(fresh.headers.get('set-cookie')).toBeNull();

        await db.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day'`);
        const touched = await api('/auth/me', { cookie });
        expect(touched.headers.get('set-cookie')).toMatch(/^rpn_session=[\w-]+;.*Max-Age=2592000/i);
        const { rows: [s] } = await db.pool.query(`SELECT expires_at > now() + interval '29 days' AS slid FROM sessions`);
        expect(s.slid).toBe(true);
    });

    it('login is rate limited per IP + email (5 failures / 15 min)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 5; i++) expect((await loginAs('limit@rpn.test', 'x')).res.status).toBe(401);
        expect((await loginAs('limit@rpn.test', 'x')).res.status).toBe(429);
        // Another account from the same IP is not locked out.
        expect((await loginAs('owner@rpn.test', 'password-owner')).res.status).toBe(200);
    });

    const changePassword = (cookie: string | undefined, current_password: unknown, new_password: unknown, origin = ORIGIN) =>
        api('/auth/change-password', { method: 'POST', cookie, headers: { origin }, body: JSON.stringify({ current_password, new_password }) });

    it('after an admin reset the user picks their own password; other sessions are signed out, this one stays', async () => {
        await auth.resetPassword('kasir@rpn.test', 'dari-admin-123');
        const phone = await loginAs('kasir@rpn.test', 'dari-admin-123');
        const laptop = await loginAs('kasir@rpn.test', 'dari-admin-123');

        const res = await changePassword(laptop.cookie, 'dari-admin-123', 'pilihan-saya-456');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });

        expect((await api('/auth/me', { cookie: laptop.cookie })).status).toBe(200);
        expect((await api('/auth/me', { cookie: phone.cookie })).status).toBe(401);
        expect((await loginAs('kasir@rpn.test', 'dari-admin-123')).res.status).toBe(401);
        expect((await loginAs('kasir@rpn.test', 'pilihan-saya-456')).res.status).toBe(200);
    });

    it('change password: wrong current is a 400 (no logout), too short / unchanged are refused, login + same origin required', async () => {
        const { cookie } = await loginAs('owner@rpn.test', 'password-owner');

        const wrong = await changePassword(cookie, 'bukan-ini', 'password-baru-1');
        expect(wrong.status).toBe(400);
        expect((await wrong.json()).message).toBe('Password lama salah');
        expect((await api('/auth/me', { cookie })).status).toBe(200);

        expect((await (await changePassword(cookie, 'password-owner', 'pendek')).json()).message).toBe('Password minimal 10 karakter');
        expect((await (await changePassword(cookie, 'password-owner', 'password-owner')).json()).message)
            .toBe('Password baru harus berbeda dari password lama');
        expect((await changePassword(cookie, '', 'password-baru-1')).status).toBe(400);

        expect((await changePassword(undefined, 'password-owner', 'password-baru-1')).status).toBe(401);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await changePassword(cookie, 'password-owner', 'password-baru-1', 'https://evil.test')).status).toBe(403);

        // Nothing above changed the password.
        expect((await loginAs('owner@rpn.test', 'password-owner')).res.status).toBe(200);
    });

    it('change password is rate limited per user (5 failures / 15 min)', async () => {
        const { cookie } = await loginAs('kasir@rpn.test', 'password-kasir');
        for (let i = 0; i < 5; i++) expect((await changePassword(cookie, 'tebak-tebak', 'password-baru-1')).status).toBe(400);
        expect((await changePassword(cookie, 'password-kasir', 'password-baru-1')).status).toBe(429);
    });

    it('delivery status/refresh/retry: the cashier (orders page) may, others not, store close stays admin-only (M1)', async () => {
        await auth.createUser({ email: 'gaji@rpn.test', password: 'password-gaji', role: 'employee', allowed_pages: ['salary'] });
        const kasir = (await loginAs('kasir@rpn.test', 'password-kasir')).cookie;
        const gaji = (await loginAs('gaji@rpn.test', 'password-gaji')).cookie;

        expect((await api('/biteship/admin/orders/999999/deliveries')).status).toBe(401);
        const list = await api('/biteship/admin/orders/999999/deliveries', { cookie: kasir });
        expect(list.status).toBe(200);
        expect((await list.json()).data).toEqual([]);
        expect((await api('/biteship/admin/orders/999999/deliveries', { cookie: gaji })).status).toBe(403);
        expect((await api('/biteship/admin/orders/999999/retry', { method: 'POST', cookie: gaji })).status).toBe(403);
        // Retry itself is allowed for the cashier (here: no such order → 404, not 403).
        expect((await api('/biteship/admin/orders/999999/retry', { method: 'POST', cookie: kasir })).status).toBe(404);

        expect((await api('/stores/1/close-orders', { method: 'POST', cookie: kasir })).status).toBe(403);
    });

    // Last in this file: it uses up the guest limit of POST /order for 127.0.0.1.
    it('POST /order: guests get 5 tries per 15 min, a logged-in session is not limited (M2)', async () => {
        const { cookie } = await loginAs('kasir@rpn.test', 'password-kasir');
        const bad = JSON.stringify({ customer_name: 'x' }); // invalid on purpose: 400, nothing is created
        for (let i = 0; i < 7; i++) expect((await api('/order', { method: 'POST', cookie, body: bad })).status).toBe(400);
        for (let i = 0; i < 5; i++) expect((await api('/order', { method: 'POST', body: bad })).status).toBe(400);
        expect((await api('/order', { method: 'POST', body: bad })).status).toBe(429);
        expect((await api('/order', { method: 'POST', cookie, body: bad })).status).toBe(400); // staff still fine
    });

    it('CLI-level validation: role, pages and password length', async () => {
        await expect(auth.createUser({ email: 'x@rpn.test', password: 'pendek', role: 'owner' })).rejects.toMatchObject({ status: 400 });
        await expect(auth.createUser({ email: 'x@rpn.test', password: 'cukup-panjang', role: 'admin' })).rejects.toMatchObject({ status: 400 });
        await expect(auth.createUser({ email: 'x@rpn.test', password: 'cukup-panjang', role: 'employee', allowed_pages: ['gudang'] })).rejects.toMatchObject({ status: 400 });
        await expect(auth.createUser({ email: 'OWNER@rpn.test', password: 'cukup-panjang', role: 'owner' })).rejects.toMatchObject({ code: '23505' });
    });
});
