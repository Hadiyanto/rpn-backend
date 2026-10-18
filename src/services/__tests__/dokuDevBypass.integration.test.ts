import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));
vi.mock('../orderEvents.service', () => ({ onOrderStatusChanged: vi.fn(), onOrderCreated: vi.fn() }));

const DATE = '2099-04-01';

describe.skipIf(!hasTestDb)('DOKU_DEV_BYPASS (local Postgres + fake Redis)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let doku: typeof import('../doku.service');
    const fetchSpy = vi.fn(async () => { throw new Error('DOKU must not be called'); });

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        doku = await import('../doku.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        fetchSpy.mockClear();
        vi.stubGlobal('fetch', fetchSpy);
        process.env.DOKU_DEV_BYPASS = 'true';
        process.env.FRONTEND_URL = 'http://localhost:3001';
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Keju')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 65000, 35000 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DOKU_DEV_BYPASS;
        delete process.env.FRONTEND_URL;
    });

    const createDokuOrder = () => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, pickup_time: '12:00', store_id: 1,
        payment_method: 'DOKU', pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }],
    });
    const row = async (id: number) =>
        (await db.pool.query('SELECT status, doku_invoice_number, doku_payment_url, doku_paid_at, doku_paid_channel FROM orders WHERE id = $1', [id])).rows[0];

    it('marks a DOKU order PAID without calling DOKU; payment_url is the status page', async () => {
        const order = await createDokuOrder();
        const started = await doku.startDokuCheckout(order);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(started.status).toBe('PAID');
        expect(started.payment_url).toBe(`http://localhost:3001/status/${order.public_token}`);
        const saved = await row(order.id);
        expect(saved).toMatchObject({ status: 'PAID', doku_paid_channel: 'DEV_BYPASS', doku_payment_url: started.payment_url });
        expect(saved.doku_invoice_number).toMatch(new RegExp(`^RPN-${order.id}-`));
        expect(saved.doku_paid_at).not.toBeNull();
    });

    it('status sync never asks DOKU while the bypass is on', async () => {
        const order = await createDokuOrder();
        await db.pool.query(`UPDATE orders SET doku_invoice_number = 'RPN-OLD-1' WHERE id = $1`, [order.id]);

        await doku.syncDokuPayment(order.public_token);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect((await row(order.id)).status).toBe('UNPAID');
    });

    it('is ignored when NODE_ENV=production: DOKU is called as usual', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const order = await createDokuOrder();
            await expect(doku.startDokuCheckout(order)).rejects.toThrow();
            // Without DOKU credentials the request is refused before fetch; the order is cancelled.
            expect((await row(order.id)).status).toBe('CANCELLED');
        } finally {
            process.env.NODE_ENV = previous;
        }
    });
});
