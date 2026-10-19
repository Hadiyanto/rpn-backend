import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));
vi.mock('../orderEvents.service', () => ({ onOrderStatusChanged: vi.fn(), onOrderCreated: vi.fn() }));
const pushes: Array<{ title: string; body: string; url?: string }> = [];
vi.mock('../push.service', () => ({
    sendPushToAll: vi.fn(async (p: { title: string; body: string; url?: string }) => { pushes.push(p); }),
}));

const DATE = '2099-06-01';
const CLIENT_ID = 'MCH-TEST-1';
const SECRET = 'SK-test-secret';
const TARGET = '/api/payments/doku/notification';

// DOKU payment problems reach admins (review 2026-10-19, H4) and DOKU orders can't be re-priced (H5).
describe.skipIf(!hasTestDb)('DOKU payment alerts + no edits to an unpaid DOKU checkout (local Postgres)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let doku: typeof import('../doku.service');
    let dokuUtils: typeof import('../../utils/doku');

    beforeAll(async () => {
        useTestDb();
        process.env.DOKU_CLIENT_ID = CLIENT_ID;
        process.env.DOKU_SECRET_KEY = SECRET;
        db = await import('../../config/db');
        orders = await import('../order.service');
        doku = await import('../doku.service');
        dokuUtils = await import('../../utils/doku');
    });

    afterAll(async () => {
        delete process.env.DOKU_CLIENT_ID;
        delete process.env.DOKU_SECRET_KEY;
        await db?.pool.end();
    });

    beforeEach(async () => {
        pushes.length = 0;
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Keju')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 65000, 35000 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    /** An UNPAID DOKU order with a checkout invoice (as startDokuCheckout leaves it). */
    const dokuOrder = async (invoice: string) => {
        const created = await orders.createOrder({
            customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1, payment_method: 'DOKU',
            pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }],
        });
        await db.pool.query('UPDATE orders SET doku_invoice_number = $2 WHERE id = $1', [created.id, invoice]);
        return created.id as number;
    };
    const notify = (invoice: string, amount: number) => {
        const body = JSON.stringify({ order: { invoice_number: invoice, amount }, transaction: { status: 'SUCCESS' }, channel: { id: 'QRIS' } });
        const headers = { 'client-id': CLIENT_ID, 'request-id': `req-${Math.random()}`, 'request-timestamp': '2099-06-01T08:00:00Z' };
        const signature = dokuUtils.dokuSignature({
            clientId: CLIENT_ID, requestId: headers['request-id'], timestamp: headers['request-timestamp'], target: TARGET, body,
        }, SECRET);
        return doku.handleDokuNotification({ ...headers, signature }, TARGET, Buffer.from(body));
    };
    const row = async (id: number) =>
        (await db.pool.query('SELECT status, doku_paid_at FROM orders WHERE id = $1', [id])).rows[0];

    it('normal payment: PAID, no admin alert', async () => {
        const id = await dokuOrder('INV-OK');
        expect(await notify('INV-OK', 130000)).toBe('paid');
        expect((await row(id)).status).toBe('PAID');
        expect(pushes).toHaveLength(0);
    });

    it('paid after the order was cancelled: status kept, one admin alert (DOKU retries stay quiet)', async () => {
        const id = await dokuOrder('INV-CANCEL');
        await orders.changeOrderStatus(id, 'CANCELLED');

        expect(await notify('INV-CANCEL', 130000)).toBe('ignored');
        expect(await notify('INV-CANCEL', 130000)).toBe('ignored');
        const saved = await row(id);
        expect(saved.status).toBe('CANCELLED');
        expect(saved.doku_paid_at).not.toBeNull();
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toBe(`💸 Order #${id} dibayar via DOKU tapi CANCELLED`);
        expect(pushes[0].body).toContain('refund atau aktifkan ulang');
        expect(pushes[0].url).toBe(`/orders?order=${id}`);
    });

    it('wrong amount: stays UNPAID, payment recorded, one admin alert with both amounts', async () => {
        const id = await dokuOrder('INV-AMOUNT');
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await notify('INV-AMOUNT', 65000)).toBe('ignored');
        expect(await notify('INV-AMOUNT', 65000)).toBe('ignored');
        const saved = await row(id);
        expect(saved.status).toBe('UNPAID');
        expect(saved.doku_paid_at).not.toBeNull();
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toBe(`⚠️ Pembayaran DOKU tidak cocok · Order #${id}`);
        expect(pushes[0].body).toContain('Rp 65.000');
        expect(pushes[0].body).toContain('Rp 130.000');
    });

    describe('expired checkouts (H3)', () => {
        /** DOKU's Check Status answer per invoice: a status, 404, or a network failure. */
        const dokuAnswers = new Map<string, 'SUCCESS' | 'PENDING' | 404 | 'down'>();
        beforeEach(() => {
            dokuAnswers.clear();
            vi.stubGlobal('fetch', vi.fn(async (url: string) => {
                const invoice = decodeURIComponent(String(url).split('/').pop() ?? '');
                const answer = dokuAnswers.get(invoice);
                if (answer === 'down') throw new TypeError('fetch failed');
                if (answer === 404) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
                return new Response(JSON.stringify({ order: { invoice_number: invoice, amount: 130000 }, transaction: { status: answer }, channel: { id: 'QRIS' } }), { status: 200 });
            }));
        });
        afterAll(() => { vi.unstubAllGlobals(); });

        const expire = (id: number, minutesAgo: number) =>
            db.pool.query(`UPDATE orders SET doku_expired_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutesAgo]);

        it('cancels expired unpaid checkouts (quota back), pays the ones DOKU says were paid, retries on outages', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            vi.spyOn(console, 'error').mockImplementation(() => {});
            await db.pool.query('UPDATE daily_quota SET qty = 50');
            const neverOpened = await dokuOrder('INV-404'); dokuAnswers.set('INV-404', 404); await expire(neverOpened, 30);
            const abandoned = await dokuOrder('INV-PENDING'); dokuAnswers.set('INV-PENDING', 'PENDING'); await expire(abandoned, 30);
            const paidLate = await dokuOrder('INV-PAID'); dokuAnswers.set('INV-PAID', 'SUCCESS'); await expire(paidLate, 30);
            const outage = await dokuOrder('INV-DOWN'); dokuAnswers.set('INV-DOWN', 'down'); await expire(outage, 30);
            const stillOpen = await dokuOrder('INV-OPEN'); await expire(stillOpen, -30); // expires in 30 min
            const justExpired = await dokuOrder('INV-GRACE'); await expire(justExpired, 2); // within the 5-min grace

            expect(await doku.expireUnpaidDokuOrders()).toEqual({ checked: 4, cancelled: 2, paid: 1 });
            expect([await row(neverOpened), await row(abandoned), await row(paidLate), await row(outage), await row(stillOpen), await row(justExpired)]
                .map(r => r.status)).toEqual(['CANCELLED', 'CANCELLED', 'PAID', 'UNPAID', 'UNPAID', 'UNPAID']);

            // The 2 cancelled orders no longer hold their boxes: 6 orders × 2 boxes − 2 × 2.
            const { rows: [used] } = await db.pool.query(`
                SELECT COALESCE(SUM(oi.qty), 0)::int AS boxes FROM orders o JOIN order_items oi ON oi.order_id = o.id
                WHERE o.status != 'CANCELLED'`);
            expect(used.boxes).toBe(8);
        });
    });

    it('items of an unpaid DOKU checkout cannot be edited; other fields and other orders can', async () => {
        const id = await dokuOrder('INV-EDIT');
        await expect(orders.updateOrder(id, { pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 3, variant_ids: [1] }] }))
            .rejects.toMatchObject({ status: 409 });
        await expect(orders.updateOrder(id, { note: 'antar sore' })).resolves.toMatchObject({ note: 'antar sore' });

        // Once paid, editing works again (DOKU no longer checks the amount).
        await notify('INV-EDIT', 130000);
        await expect(orders.updateOrder(id, { pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 3, variant_ids: [1] }] })).resolves.toBeTruthy();
    });
});
