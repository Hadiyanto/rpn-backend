import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

const biteshipPost = vi.fn();
vi.mock('../../utils/biteship', () => ({ biteshipPost, biteshipGet: vi.fn() }));

const sendMessage = vi.fn(async () => undefined);
vi.mock('../whatsapp.service', () => ({ getWhatsAppService: () => ({ isConnected: true, sendMessage }) }));
vi.mock('../push.service', () => ({ sendPushToAll: vi.fn(async () => undefined) }));

describe.skipIf(!hasTestDb)('order events: WhatsApp + idempotent Biteship dispatch', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let events: typeof import('../orderEvents.service');
    let biteship: typeof import('../biteship.service');
    let date: typeof import('../../utils/date');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        events = await import('../orderEvents.service');
        biteship = await import('../biteship.service');
        date = await import('../../utils/date');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        biteshipPost.mockReset();
        biteshipPost.mockResolvedValue({ id: 'bs-123' });
        sendMessage.mockClear();
        await db.pool.query('TRUNCATE orders, order_items, daily_quota, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price) VALUES ('FULL', 65000), ('HALF', 35000)`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 100, 1)`, [date.todayWIB()]);
    });

    const deliveryOrder = () => orders.createOrder({
        customer_name: 'Budi', customer_phone: '081234567890', pickup_date: date.todayWIB(), pickup_time: '12:00', store_id: 1,
        pesanan: [{ box_type: 'FULL', name: 'Keju', qty: 2 }],
        delivery_method: 'store_delivery', delivery_lat: -6.25, delivery_lng: 106.85,
        delivery_address: 'Jl. Contoh 1, Jakarta 12750', delivery_area_id: 'AREA-1',
    });

    const setStatus = async (id: number, status: string) => {
        const { previousStatus } = await orders.changeOrderStatus(id, status);
        await events.onOrderStatusChanged(await orders.getOrderById(id), previousStatus);
    };

    it('PAID dispatches once, stores the Biteship id, and uses today (WIB) → delivery_type now', async () => {
        const order = await deliveryOrder();
        await setStatus(order.id, 'PAID');

        expect(biteshipPost).toHaveBeenCalledTimes(1);
        const [path, payload] = biteshipPost.mock.calls[0];
        expect(path).toBe('/orders');
        expect(payload).toMatchObject({ delivery_type: 'now', destination_area_id: 'AREA-1', origin_contact_name: 'RPN Store Pancoran' });
        expect(payload.items[0]).toMatchObject({ value: 65000, quantity: 2 });
        expect((await orders.getOrderById(order.id)).biteship_order_id).toBe('bs-123');

        // PAID → UNPAID → PAID must not create a second shipment.
        await setStatus(order.id, 'UNPAID');
        await setStatus(order.id, 'PAID');
        expect(biteshipPost).toHaveBeenCalledTimes(1);
    });

    it('parallel dispatch attempts create exactly one shipment', async () => {
        const order = await deliveryOrder();
        const full = await orders.getOrderById(order.id);
        const results = await Promise.all(Array.from({ length: 5 }, () => biteship.createBiteshipDispatch(full)));
        expect(biteshipPost).toHaveBeenCalledTimes(1);
        expect(results.filter(r => r.status === 'created')).toHaveLength(1);
    });

    it('a failed dispatch releases the claim so it can be retried', async () => {
        const order = await deliveryOrder();
        biteshipPost.mockRejectedValueOnce(new Error('Biteship down'));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await setStatus(order.id, 'PAID');
        } finally {
            errors.mockRestore();
        }
        expect((await orders.getOrderById(order.id)).biteship_order_id).toBeNull();

        await setStatus(order.id, 'UNPAID');
        await setStatus(order.id, 'PAID');
        expect(biteshipPost).toHaveBeenCalledTimes(2);
        expect((await orders.getOrderById(order.id)).biteship_order_id).toBe('bs-123');
    });

    it('WhatsApp only on a real status change; pickup orders are never dispatched', async () => {
        const order = await orders.createOrder({
            customer_name: 'Sari', customer_phone: '081234567891', pickup_date: date.todayWIB(), store_id: 1,
            pesanan: [{ box_type: 'HALF', name: 'Keju', qty: 1 }],
        });
        await setStatus(order.id, 'PAID');
        expect(sendMessage).toHaveBeenCalledTimes(1);
        await setStatus(order.id, 'PAID'); // unchanged → nothing
        expect(sendMessage).toHaveBeenCalledTimes(1);
        await setStatus(order.id, 'DONE');
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(biteshipPost).not.toHaveBeenCalled();
    });
});
