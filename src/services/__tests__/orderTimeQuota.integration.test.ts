import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

// "Now" for these tests: 2099-08-01 15:00 WIB.
const TODAY = '2099-08-01';
const NOW = new Date('2099-08-01T08:00:00Z');
const TOMORROW = '2099-08-02';

// Pickup times (M3), orders without a time vs hourly slots (M5), the quota list (L2), admin edits (L3).
describe.skipIf(!hasTestDb)('pickup time + quota rules (local Postgres + fake Redis)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let daily: typeof import('../dailyQuota.service');
    let hourly: typeof import('../hourlyQuota.service');
    let storeHours: { id: number; open_time: string; last_pickup_time: string }[] = [];

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        daily = await import('../dailyQuota.service');
        hourly = await import('../hourlyQuota.service');
        storeHours = (await db.pool.query('SELECT id, open_time, last_pickup_time FROM stores')).rows;
    });

    afterAll(async () => {
        for (const st of storeHours) {
            await db.pool.query('UPDATE stores SET open_time = $2, last_pickup_time = $3 WHERE id = $1', [st.id, st.open_time, st.last_pickup_time]);
        }
        await db?.pool.end();
    });

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`UPDATE stores SET open_time = '10:00', last_pickup_time = '19:00'`);
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Keju')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 65000, 35000 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1), ($2, 10, 1)`, [TODAY, TOMORROW]);
    });

    afterEach(() => { vi.useRealTimers(); });

    const order = (fields: Record<string, unknown> = {}, opts?: { staff?: boolean }) => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: TODAY, store_id: 1,
        pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }], ...fields,
    } as any, opts);

    it('a time that already passed today is refused for customers, allowed for staff; later today and tomorrow are fine', async () => {
        await expect(order({ pickup_time: '14:55' })).rejects.toMatchObject({ status: 409, message: 'MOHON MAAF: Jam pengambilan sudah lewat. Silakan pilih jam lain.' });
        expect(fakeRedis.store.size).toBe(0); // refused before any quota is reserved
        await expect(order({ pickup_time: '15:00' })).resolves.toBeTruthy();
        await expect(order({ pickup_time: '11:00', pickup_date: TOMORROW })).resolves.toBeTruthy();
        await expect(order({ pickup_time: '11:00' }, { staff: true })).resolves.toBeTruthy();
        // Store hours still apply to staff.
        await expect(order({ pickup_time: '19:30' }, { staff: true })).rejects.toMatchObject({ status: 409 });
    });

    it('an order without a time is stored without one and never fills the 11:00 slot', async () => {
        await db.pool.query(`INSERT INTO hourly_quota (time_str, qty, is_active, store_id) VALUES ('11:00', 3, true, 1)`);
        const created = await order({ pickup_date: TOMORROW });
        expect(created.pickup_time).toBeNull();
        // A range is no slot either (old rows carry the former default).
        await db.pool.query(`UPDATE orders SET pickup_time = '11:00 - 16:00' WHERE id = $1`, [created.id]);
        await order({ pickup_date: TOMORROW });

        await hourly.syncHourlyRedisQuota(TOMORROW, 1);
        const slot = (await hourly.getHourlyAvailability(TOMORROW, 1)).find(s => s.time_str === '11:00')!;
        expect(slot.remaining_qty).toBe(3);

        await order({ pickup_date: TOMORROW, pickup_time: '11:30' }); // a real 11:xx order does count
        await hourly.syncHourlyRedisQuota(TOMORROW, 1);
        expect((await hourly.getHourlyAvailability(TOMORROW, 1)).find(s => s.time_str === '11:00')!.remaining_qty).toBe(1);
    });

    it('the quota list keeps the nearest dates even when many days are opened ahead', async () => {
        await db.pool.query(`
            INSERT INTO daily_quota (date, qty, store_id)
            SELECT d::date, 10, 1 FROM generate_series('2099-08-03'::date, '2099-09-30'::date, interval '1 day') d`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ('2099-07-01', 10, 1)`); // a month back
        const dates = (await daily.getDailyQuotas(1)).map(q => q.date);
        expect(dates).toContain(TODAY);
        expect(dates).toContain(TOMORROW);
        expect(dates).toContain('2099-09-30');
        expect(dates).not.toContain('2099-07-01');
        expect(dates[0]).toBe('2099-09-30'); // newest first, as before
    });

    it('admin edits must fit the quota and store hours; an unchanged edit on a full day still saves', async () => {
        await db.pool.query(`INSERT INTO hourly_quota (time_str, qty, is_active, store_id) VALUES ('16:00', 2, true, 1)`);
        const a = await order({ pickup_time: '16:10' });          // 2 boxes, hour 16 full now
        const b = await order({ pickup_time: '17:00' });          // 2 boxes
        await order({ qty: 0, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 6, variant_ids: [1] }] }); // day: 10/10

        const keju = (qty: number) => [{ box_type: 'FULL' as const, name: 'Keju', qty, variant_ids: [1] }];
        await expect(orders.updateOrder(b.id, { pesanan: keju(3) })).rejects.toMatchObject({ status: 409, message: `MOHON MAAF: Kuota Box untuk tanggal ${TODAY} sudah penuh.` });
        await expect(orders.updateOrder(b.id, { pickup_time: '16:30' })).rejects.toMatchObject({ status: 409, message: `MOHON MAAF: Kuota Jam 16:00 di tanggal ${TODAY} sudah penuh. Silakan pilih jam lain.` });
        await expect(orders.updateOrder(b.id, { pickup_time: '09:00' })).rejects.toMatchObject({ status: 409 }); // before opening
        await expect(orders.updateOrder(b.id, { pickup_date: '2099-08-20' })).rejects.toMatchObject({ status: 400 }); // not opened

        await expect(orders.updateOrder(a.id, { note: 'tanpa saus' })).resolves.toMatchObject({ note: 'tanpa saus' });
        await expect(orders.updateOrder(b.id, { pickup_date: TOMORROW, pesanan: keju(3) })).resolves.toBeTruthy(); // tomorrow has room
        await expect(orders.updateOrder(a.id, { pickup_time: '12:00' })).resolves.toBeTruthy(); // past time is fine for staff
    });
});
