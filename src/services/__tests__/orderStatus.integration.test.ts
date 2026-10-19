import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));
const pushes: Array<{ title: string; body: string }> = [];
vi.mock('../push.service', () => ({
    sendPushToAll: vi.fn(async (p: { title: string; body: string }) => { pushes.push(p); }),
}));
const calls: Array<{ path: string; body: any }> = [];
let cancelFails = false;
vi.mock('../../utils/biteship', () => ({
    biteshipGet: vi.fn(async () => ({ areas: [] })),
    biteshipPost: vi.fn(async (path: string, body: any) => {
        calls.push({ path, body });
        if (path.endsWith('/cancel')) {
            if (cancelFails) throw new Error('Order cannot be cancelled after pickup');
            return { success: true, status: 'cancelled' };
        }
        if (path === '/orders') return { id: 'bs-1', status: 'confirmed', courier: { link: 'https://track.test/1' } };
        return { pricing: [{ courier_code: 'grab', courier_service_code: 'instant', price: 19000 }] };
    }),
}));

const DATE = '2099-07-01';

// Status rules (review 2026-10-19, M8) and cancelling the courier with the order (H6).
describe.skipIf(!hasTestDb)('order status transitions + courier cancel (local Postgres)', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let biteship: typeof import('../biteship.service');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        biteship = await import('../biteship.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        pushes.length = 0;
        calls.length = 0;
        cancelFails = false;
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, order_delivery_attempts, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Keju')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 65000, 35000 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 10, 1)`, [DATE]);
    });

    const pickupOrder = () => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1, payment_method: 'TRANSFER',
        pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }],
    });
    const deliveryOrder = () => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1, payment_method: 'TRANSFER',
        pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2, variant_ids: [1] }],
        delivery_method: 'store_delivery', delivery_lat: -6.24, delivery_lng: 106.84, delivery_address: 'Jl. Test 12780',
        delivery_courier_company: 'grab', delivery_courier_type: 'instant',
    });
    const statusOf = async (id: number) => (await db.pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status;
    const stockMoves = async (id: number) => Number((await db.pool.query('SELECT COUNT(*) FROM stock_history WHERE order_id = $1', [id])).rows[0].count);

    it('blocks a cancelled order from jumping to PAID/CONFIRMED/DONE and a DONE order back to UNPAID/PAID', async () => {
        const id = (await pickupOrder()).id;
        await orders.changeOrderStatus(id, 'DONE');
        await expect(orders.changeOrderStatus(id, 'UNPAID')).rejects.toMatchObject({ status: 409, message: 'Status DONE tidak bisa diubah ke UNPAID.' });
        await expect(orders.changeOrderStatus(id, 'PAID')).rejects.toMatchObject({ status: 409 });
        await orders.changeOrderStatus(id, 'CONFIRMED'); // correction is fine

        await orders.changeOrderStatus(id, 'CANCELLED');
        for (const to of ['PAID', 'CONFIRMED', 'DONE']) {
            await expect(orders.changeOrderStatus(id, to)).rejects.toMatchObject({ status: 409, message: `Order yang sudah CANCELLED tidak bisa langsung jadi ${to}. Buka ulang ke UNPAID dulu.` });
        }
        expect(await statusOf(id)).toBe('CANCELLED');

        // Reopen, then the normal flow.
        await orders.changeOrderStatus(id, 'UNPAID');
        await orders.changeOrderStatus(id, 'PAID');
        expect(await statusOf(id)).toBe('PAID');
    });

    it('setting the same status again changes nothing (no second stock reversal)', async () => {
        const id = (await pickupOrder()).id;
        await orders.changeOrderStatus(id, 'CANCELLED');
        const moves = await stockMoves(id);
        const again = await orders.changeOrderStatus(id, 'CANCELLED');
        expect(again.previousStatus).toBe('CANCELLED');
        expect(await stockMoves(id)).toBe(moves);
    });

    it('cancelling a store-delivery order cancels its open Biteship shipment', async () => {
        const id = (await deliveryOrder()).id;
        await orders.changeOrderStatus(id, 'DONE');
        await biteship.createBiteshipDispatch(await orders.getOrderById(id));
        calls.length = 0;

        await orders.changeOrderStatus(id, 'CANCELLED');
        expect(calls.map(c => c.path)).toEqual(['/orders/bs-1/cancel']);
        expect(calls[0].body).toEqual({ cancellation_reason_code: 'others', cancellation_reason: `Order RPN #${id} dibatalkan` });
        const [attempt] = await biteship.getDeliveryAttempts(id);
        expect(attempt).toMatchObject({ status: 'CANCELLED', failure_message: 'Dibatalkan karena order RPN dibatalkan' });
        expect(pushes).toHaveLength(0);
    });

    it('when Biteship refuses the cancel, the order is still cancelled and admins are alerted', async () => {
        const id = (await deliveryOrder()).id;
        await orders.changeOrderStatus(id, 'DONE');
        await biteship.createBiteshipDispatch(await orders.getOrderById(id));
        cancelFails = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await orders.changeOrderStatus(id, 'CANCELLED');
        expect(await statusOf(id)).toBe('CANCELLED');
        expect((await biteship.getDeliveryAttempts(id))[0].status).toBe('PENDING');
        expect(pushes).toHaveLength(1);
        expect(pushes[0].title).toBe(`⚠️ Kurir belum dibatalkan · Order #${id}`);
        expect(pushes[0].body).toContain('cannot be cancelled after pickup');
    });

    it('pickup orders never call Biteship when cancelled', async () => {
        const id = (await pickupOrder()).id;
        await orders.changeOrderStatus(id, 'CANCELLED');
        expect(calls.some(c => c.path.endsWith('/cancel'))).toBe(false);
    });
});
