import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';
import { redisKeys } from '../../utils/redisKeys';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

const DATE = '2099-01-05';

describe.skipIf(!hasTestDb)('quota under load (local Postgres + in-memory Redis)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');

    const base = { customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1 };
    const orderCount = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM orders WHERE status != 'CANCELLED'`)).rows[0].n;

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, daily_quota, hourly_quota, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, max_flavors, box_multiplier) VALUES ('FULL', 65000, 3, 1), ('HALF', 35000, 1, 0.5)`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    it('20 parallel orders for 10 boxes: exactly 10 succeed, the rest get 409, no overbooking', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 20 }, () => orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] }))
        );
        const ok = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(ok).toHaveLength(10);
        expect(rejected.every(r => r.reason?.status === 409)).toBe(true);
        expect(await orderCount()).toBe(10);
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(0);
    });

    it('hourly slot cap also holds under parallel load', async () => {
        await db.pool.query(`INSERT INTO hourly_quota (time_str, qty, is_active, store_id) VALUES ('12:00', 3, true, 1)`);
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, () => orders.createOrder({ ...base, pickup_time: '12:30', pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] }))
        );
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
        // The 5 rejected by the hourly cap must have given their daily reservation back.
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(7);
    });

    it('cancel frees quota, un-cancel takes it again (HALF = 0.5)', async () => {
        const a = await orders.createOrder({ ...base, pesanan: [{ box_type: 'HALF', name: 'Keju', qty: 4 }] }); // 2 boxes
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(8);
        await orders.updateOrderStatus(a.id, 'CANCELLED');
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(10);
        await orders.updateOrderStatus(a.id, 'UNPAID');
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(8);
    });

    it('editing an order resyncs quota for the old and the new date', async () => {
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ('2099-01-06', 10, 1)`);
        const a = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 3 }] });
        await orders.updateOrder(a.id, { pickup_date: '2099-01-06', pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 4 }] });
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, DATE))).toBe(10);
        expect(fakeRedis.store.get(redisKeys.dailyQuota(1, '2099-01-06'))).toBe(6);
    });
});
