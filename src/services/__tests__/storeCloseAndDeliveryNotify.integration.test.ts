import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));
const pushes: Array<{ title: string; body: string; url?: string; tag?: string }> = [];
vi.mock('../push.service', () => ({
    sendPushToAll: vi.fn(async (payload: { title: string; body: string; url?: string; tag?: string }) => { pushes.push(payload); }),
}));

const DATE = '2099-02-01';

describe.skipIf(!hasTestDb)('store close with UNPAID cancel + Biteship admin notifications (local Postgres)', () => {
    let db: typeof import('../../config/db');
    let closure: typeof import('../storeClosure.service');
    let biteship: typeof import('../biteship.service');
    let orders: typeof import('../order.service');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        closure = await import('../storeClosure.service');
        biteship = await import('../biteship.service');
        orders = await import('../order.service');
    });

    afterAll(async () => {
        await db?.pool.query('UPDATE stores SET is_open_for_orders = true');
        await db?.pool.end();
    });

    beforeEach(async () => {
        pushes.length = 0;
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_delivery_attempts, daily_quota, hourly_quota RESTART IDENTITY CASCADE');
        await db.pool.query('UPDATE stores SET is_open_for_orders = true');
    });

    const addOrder = async (storeId: number, status: string, name = 'Budi') => {
        const { rows } = await db.pool.query(
            `INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id) VALUES ($1, '081234567890', $2, $3, $4) RETURNING id`,
            [name, DATE, status, storeId]);
        return rows[0].id as number;
    };
    const statusOf = async (id: number) => (await db.pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status;
    const isOpen = async (storeId: number) => (await db.pool.query('SELECT is_open_for_orders FROM stores WHERE id = $1', [storeId])).rows[0].is_open_for_orders;

    it('PAID/CONFIRMED block the close, list every blocker and alert admins; the store stays open', async () => {
        const paid = await addOrder(1, 'PAID');
        const confirmed = await addOrder(1, 'CONFIRMED');
        await addOrder(1, 'UNPAID');
        await addOrder(2, 'PAID'); // other store: irrelevant

        const result = await closure.closeStore(1);
        expect(result.outcome).toBe('blocked');
        expect(result.blockers.map(o => o.id)).toEqual([paid, confirmed]);
        expect(await isOpen(1)).toBe(true);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].body).toContain(`#${paid}, #${confirmed}`);
    });

    it('UNPAID orders: first ask (exact ids in the message), then cancel exactly those, close and inform admins', async () => {
        const a = await addOrder(1, 'UNPAID', 'Ani');
        const b = await addOrder(1, 'UNPAID', 'Bayu');
        const done = await addOrder(1, 'DONE');
        const otherStore = await addOrder(2, 'UNPAID');

        const ask = await closure.closeStore(1);
        expect(ask.outcome).toBe('confirm_unpaid');
        if (ask.outcome !== 'confirm_unpaid') return;
        expect(closure.unpaidCancelMessage(ask.unpaid))
            .toBe(`Order #${a}, #${b} masih UNPAID. Tutup toko akan mengubah status order tersebut menjadi CANCELLED.`);
        expect(await isOpen(1)).toBe(true);
        expect(pushes).toHaveLength(0);

        const closed = await closure.closeStore(1, [b, a]);
        expect(closed.outcome).toBe('closed');
        expect(await isOpen(1)).toBe(false);
        expect([await statusOf(a), await statusOf(b), await statusOf(done), await statusOf(otherStore)])
            .toEqual(['CANCELLED', 'CANCELLED', 'DONE', 'UNPAID']);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toContain('ditutup');
        expect(pushes[0].body).toContain(`#${a}, #${b} dibatalkan`);
        expect(await isOpen(2)).toBe(true);
    });

    it('a confirmation that no longer matches (new UNPAID order) asks again instead of closing', async () => {
        const a = await addOrder(1, 'UNPAID');
        const late = await addOrder(1, 'UNPAID');
        const again = await closure.closeStore(1, [a]);
        expect(again.outcome).toBe('confirm_unpaid');
        if (again.outcome === 'confirm_unpaid') expect(again.unpaid.map(o => o.id)).toEqual([a, late]);
        expect(await isOpen(1)).toBe(true);
        expect(await statusOf(a)).toBe('UNPAID');
    });

    it('an automatic cancel never overwrites a payment that landed meanwhile (expectedStatus)', async () => {
        const id = await addOrder(1, 'PAID');
        await expect(orders.changeOrderStatus(id, 'CANCELLED', { expectedStatus: 'UNPAID' })).rejects.toMatchObject({ status: 409 });
        expect(await statusOf(id)).toBe('PAID');
    });

    const addAttempt = async (orderId: number, fields: Record<string, unknown>) => {
        const { rows } = await db.pool.query(`
            INSERT INTO order_delivery_attempts (order_id, attempt_no, status, courier_company, courier_type, driver_name, driver_plate_number,
                failure_message, provider_status, provider_updated_at)
            VALUES ($1, 1, $2, 'grab', 'instant', $3, $4, $5, $6, $7) RETURNING id`,
            [orderId, fields.status, fields.driver_name ?? null, fields.driver_plate_number ?? null, fields.failure_message ?? null,
                fields.provider_status ?? null, fields.provider_updated_at ?? null]);
        return rows[0].id as number;
    };

    it('delivered: one clear push (customer, store, courier, driver, WIB time, deep link), never twice', async () => {
        const orderId = await addOrder(1, 'DONE', 'Citra');
        const attempt = await addAttempt(orderId, {
            status: 'DELIVERED', driver_name: 'Andi', driver_plate_number: 'B 1234 XYZ', provider_updated_at: '2099-02-01T07:32:00Z',
        });
        await biteship.notifyDeliveryDelivered(attempt);
        await biteship.notifyDeliveryDelivered(attempt);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toBe(`✅ Order #${orderId} sudah sampai`);
        expect(pushes[0].body).toBe('Diterima Citra · RPN Store Pancoran\nKurir: GrabExpress Instant · Andi (B 1234 XYZ)\nTiba 14:32 WIB');
        expect(pushes[0].url).toBe(`/orders?order=${orderId}`);
    });

    it('allocation failure: one push with the reason and what to do; not for an attempt that is fine', async () => {
        const orderId = await addOrder(1, 'DONE', 'Dewi');
        const failed = await addAttempt(orderId, { status: 'FAILED', failure_message: 'Courier not found', provider_status: 'courier_not_found' });
        await biteship.notifyDeliveryProblem(failed);
        await biteship.notifyDeliveryProblem(failed);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toBe(`⚠️ Kurir tidak didapat · Order #${orderId}`);
        expect(pushes[0].body).toContain('Dewi · RPN Store Pancoran · GrabExpress Instant (percobaan 1)');
        expect(pushes[0].body).toContain('Alasan: Courier not found');
        expect(pushes[0].body).toContain('coba ulang');

        await db.pool.query('UPDATE order_delivery_attempts SET status = $2 WHERE id = $1', [failed, 'ALLOCATED']);
        const ok = await addAttempt(await addOrder(1, 'DONE'), { status: 'ALLOCATED' });
        await biteship.notifyDeliveryProblem(ok);
        expect(pushes).toHaveLength(1);
    });
});
