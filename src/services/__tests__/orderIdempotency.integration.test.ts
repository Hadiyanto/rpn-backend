import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';
import { redisKeys } from '../../utils/redisKeys';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

const DATE = '2099-09-01';

// POST /order + Idempotency-Key (review 2026-10-19, I8).
describe.skipIf(!hasTestDb)('order idempotency (local Postgres + fake Redis)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let idem: typeof import('../orderIdempotency.service');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        idem = await import('../orderIdempotency.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Keju')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 65000, 35000 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    const create = () => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1,
        pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }],
    });
    const count = async () => Number((await db.pool.query('SELECT COUNT(*) FROM orders')).rows[0].count);

    it('the same key twice: one order, the resend gets it back (marked replayed)', async () => {
        const first = await idem.createOrderOnce('key-123456', create);
        const again = await idem.createOrderOnce('key-123456', create);
        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.data.id).toBe(first.data.id);
        expect(await count()).toBe(1);
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(8); // quota taken once
    });

    it('while the first request is still running a resend gets 409; a failed attempt frees the key', async () => {
        fakeRedis.store.set(redisKeys.orderIdempotency('key-busy-01'), 0);
        await expect(idem.createOrderOnce('key-busy-01', create)).rejects.toMatchObject({ status: 409 });

        await expect(idem.createOrderOnce('key-fail-01', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(idem.createOrderOnce('key-fail-01', create)).resolves.toMatchObject({ replayed: false });
        expect(await count()).toBe(1);
    });

    it('no key or an invalid one: just creates', async () => {
        await idem.createOrderOnce(undefined, create);
        await idem.createOrderOnce('bad key!', create);
        expect(await count()).toBe(2);
    });
});
