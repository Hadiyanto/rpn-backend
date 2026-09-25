import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

const DATE = '2099-01-05';

describe.skipIf(!hasTestDb)('orders with variant_ids (local Postgres + fake Redis)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');

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
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Dark Choco'), ('Vanilla'), ('Keju')`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    const base = {
        customer_name: 'Budi',
        customer_phone: '081234567890',
        pickup_date: DATE,
        pickup_time: '12:00',
        store_id: 1,
    };

    it('stores variant_ids and returns them from getOrderById', async () => {
        const created = await orders.createOrder({
            ...base,
            pesanan: [
                { box_type: 'FULL', name: 'Mix Dark Choco Dan Vanilla', qty: 2, variant_ids: [1, 2] },
                { box_type: 'HALF', name: 'Keju', qty: 1, variant_ids: [3] },
                { box_type: 'FULL', name: 'Mix Dark Choco Dan Keju Dan Vanilla', qty: 1, variant_ids: [1, 2, 3] },
            ],
        });
        const fetched = await orders.getOrderById(created.id);
        expect(fetched.items.map((i: any) => i.variant_ids)).toEqual([[1, 2], [3], [1, 2, 3]]);
        expect(typeof fetched.pickup_date).toBe('string');
    });

    it('cold Redis cache is warmed from DB instead of rejecting as full', async () => {
        await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 4 }] });
        fakeRedis.store.clear(); // simulate eviction
        await orders.createOrder({ ...base, pesanan: [{ box_type: 'HALF', name: 'Keju', qty: 2 }] });
        // 10 − 4 − (2 × 0.5) = 5
        expect(fakeRedis.store.get(`quota:1:${DATE}`)).toBe(5);
    });

    it('rejects a date without daily quota with a clear message', async () => {
        await expect(orders.createOrder({ ...base, pickup_date: '2099-02-01', pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] }))
            .rejects.toThrow(/belum dibuka/);
    });

    it('rejects invalid selections before touching quota', async () => {
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'HALF', name: 'x', qty: 1, variant_ids: [1, 2] }] }))
            .rejects.toThrow(/maksimal 1 rasa/);
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'x', qty: 1, variant_ids: [1, 1] }] }))
            .rejects.toThrow(/dua kali/);
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'x', qty: -5 }] }))
            .rejects.toThrow(/qty/);
        expect(fakeRedis.store.size).toBe(0);
    });

    it('getMenuPriceMap: active menus for new orders, all menus for historical revenue', async () => {
        await db.pool.query(`INSERT INTO menu (name, price, is_active) VALUES ('HAMPERS', 135000, false)`);
        const { getMenuPriceMap } = await import('../menu.service');
        expect(Object.fromEntries(await getMenuPriceMap())).toEqual({ FULL: 65000, HALF: 35000 });
        expect((await getMenuPriceMap({ activeOnly: false })).get('HAMPERS')).toBe(135000);
    });

    it('public token: minimal public view, unknown/invalid tokens → 404, Cloudinary-only proof URLs', async () => {
        const created = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] });
        expect(created.public_token).toMatch(/^[0-9a-f-]{36}$/);

        const pub = await orders.getPublicOrder(created.public_token);
        expect(pub).toMatchObject({ id: created.id, customer_name: 'Budi', has_transfer_img: false, items: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] });
        expect(pub).not.toHaveProperty('customer_phone');
        expect(pub).not.toHaveProperty('delivery_address');

        await expect(orders.getPublicOrder('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
        await expect(orders.getPublicOrder(String(created.id))).rejects.toMatchObject({ status: 404 });

        expect(() => orders.assertTransferImgUrl('https://evil.example.com/x.png')).toThrow(/URL gambar/);
        expect(orders.assertTransferImgUrl('https://res.cloudinary.com/demo/image/upload/x.jpg')).toContain('cloudinary');
    });

    it('business errors carry HTTP statuses (quota full → 409, unknown order → 404)', async () => {
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 11 }] }))
            .rejects.toMatchObject({ status: 409 });
        await expect(orders.getOrderById(999999)).rejects.toMatchObject({ status: 404 });
    });

    it('rejects a box that is inactive or not sold at the store', async () => {
        await db.pool.query(`UPDATE menu SET store_ids = '{2}' WHERE name = 'HALF'`);
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'HALF', name: 'Keju', qty: 1, variant_ids: [3] }] }))
            .rejects.toThrow(/Box Kecil tidak tersedia/);
        await db.pool.query(`UPDATE menu SET store_ids = '{1,2}', is_active = false WHERE name = 'FULL'`);
        await expect(orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1, variant_ids: [3] }] }))
            .rejects.toThrow(/Box Besar tidak tersedia/);
        expect(fakeRedis.store.size).toBe(0);
    });

    it('legacy items without variant_ids still work', async () => {
        const created = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1 }] });
        const fetched = await orders.getOrderById(created.id);
        expect(fetched.items[0].variant_ids).toEqual([]);
    });

    it('updateOrder replaces items and variants atomically', async () => {
        const created = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 1, variant_ids: [3] }] });

        await orders.updateOrder(created.id, {
            customer_name: 'Budi Baru',
            pesanan: [{ box_type: 'FULL', name: 'Mix Dark Choco Dan Vanilla', qty: 3, variant_ids: [1, 2] }],
        });
        const fetched = await orders.getOrderById(created.id);
        expect(fetched.customer_name).toBe('Budi Baru');
        expect(fetched.items).toHaveLength(1);
        expect(fetched.items[0]).toMatchObject({ qty: 3, variant_ids: [1, 2] });

        // Invalid edit → nothing changes (header included).
        await expect(orders.updateOrder(created.id, {
            customer_name: 'Tidak Boleh',
            pesanan: [{ box_type: 'HALF', name: 'x', qty: 1, variant_ids: [1, 2] }],
        })).rejects.toThrow();
        const unchanged = await orders.getOrderById(created.id);
        expect(unchanged.customer_name).toBe('Budi Baru');
        expect(unchanged.items[0].variant_ids).toEqual([1, 2]);
    });
});
