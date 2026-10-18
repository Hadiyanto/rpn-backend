import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';

const pushes: Array<{ title: string }> = [];
vi.mock('../push.service', () => ({
    sendPushToAll: vi.fn(async (payload: { title: string }) => { pushes.push(payload); }),
}));
// Biteship's GET /orders/:id, per Biteship order id.
const remote = new Map<string, unknown>();
vi.mock('../../utils/biteship', () => ({
    biteshipGet: vi.fn(async (path: string) => remote.get(decodeURIComponent(path.replace('/orders/', '')))),
    biteshipPost: vi.fn(),
}));

const HEADER = 'x-test-biteship-secret';
const SECRET = 'test-secret';

describe.skipIf(!hasTestDb)('Biteship delivery attempts: refresh + webhook (local Postgres)', () => {
    let db: typeof import('../../config/db');
    let biteship: typeof import('../biteship.service');

    beforeAll(async () => {
        useTestDb();
        process.env.BITESHIP_WEBHOOK_HEADER = HEADER;
        process.env.BITESHIP_WEBHOOK_SECRET = SECRET;
        db = await import('../../config/db');
        biteship = await import('../biteship.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        pushes.length = 0;
        remote.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_delivery_attempts, biteship_webhook_events RESTART IDENTITY CASCADE');
    });

    const addOrder = async () => {
        const { rows } = await db.pool.query(`
            INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id, delivery_method)
            VALUES ('Eka', '081234567890', '2099-03-01', 'DONE', 1, 'store_delivery') RETURNING id`);
        return rows[0].id as number;
    };
    const addAttempt = async (orderId: number, attemptNo: number, status: string, biteshipId: string) => {
        const { rows } = await db.pool.query(`
            INSERT INTO order_delivery_attempts (order_id, attempt_no, status, biteship_order_id, courier_company, courier_type)
            VALUES ($1, $2, $3, $4, 'grab', 'instant') RETURNING id`, [orderId, attemptNo, status, biteshipId]);
        return rows[0].id as number;
    };
    const attempt = async (id: number) =>
        (await db.pool.query('SELECT status, provider_status, failure_message, driver_name FROM order_delivery_attempts WHERE id = $1', [id])).rows[0];
    const webhook = (body: Record<string, unknown>) => {
        const raw = Buffer.from(JSON.stringify(body));
        return biteship.processBiteshipWebhook(body, raw, { [HEADER]: SECRET });
    };

    it('refresh keeps a FAILED attempt FAILED (retry already active) and still updates the active one', async () => {
        const orderId = await addOrder();
        const failed = await addAttempt(orderId, 1, 'FAILED', 'bs-1');
        const active = await addAttempt(orderId, 2, 'PENDING', 'bs-2');
        // The old Biteship order still looks open on Biteship's side.
        remote.set('bs-1', { status: 'confirmed' });
        remote.set('bs-2', { status: 'allocated', courier: { driver_name: 'Andi' } });

        await biteship.refreshDeliveryAttempts(orderId);

        expect(await attempt(failed)).toMatchObject({ status: 'FAILED', provider_status: 'confirmed' });
        expect(await attempt(active)).toMatchObject({ status: 'ALLOCATED', provider_status: 'allocated', driver_name: 'Andi' });
    });

    it('refresh marks an open attempt FAILED when Biteship found no courier', async () => {
        const orderId = await addOrder();
        const id = await addAttempt(orderId, 1, 'PENDING', 'bs-3');
        remote.set('bs-3', { status: 'courier_not_found' });

        await biteship.refreshDeliveryAttempts(orderId);

        expect(await attempt(id)).toMatchObject({ status: 'FAILED', failure_message: 'Biteship gagal mengalokasikan kurir.' });
    });

    const NOT_FOUND = {
        status: 'courier_not_found',
        courier: { history: [
            { status: 'confirmed', note: 'Courier order is confirmed.' },
            { status: 'courier_not_found', note: 'Order is rejected bacause no courier picking up order' },
        ] },
    };

    it("poll: an open attempt Biteship couldn't allocate becomes FAILED with Biteship's note, one push", async () => {
        const orderId = await addOrder();
        const id = await addAttempt(orderId, 1, 'PENDING', 'bs-6');
        remote.set('bs-6', NOT_FOUND);

        expect(await biteship.pollActiveDeliveryAttempts()).toEqual({ checked: 1, changed: 1 });
        expect(await attempt(id)).toMatchObject({
            status: 'FAILED', provider_status: 'courier_not_found', failure_message: 'Order is rejected bacause no courier picking up order',
        });
        await vi.waitFor(() => expect(pushes).toHaveLength(1));
        expect(pushes[0].title).toBe(`⚠️ Kurir tidak didapat · Order #${orderId}`);

        // Next round: the attempt is no longer open, so it is neither fetched nor notified again.
        expect(await biteship.pollActiveDeliveryAttempts()).toEqual({ checked: 0, changed: 0 });
        expect(pushes).toHaveLength(1);
    });

    it('poll: skips final attempts and attempts booked more than a day ago; a cancellation keeps its note', async () => {
        const orderId = await addOrder();
        await addAttempt(orderId, 1, 'FAILED', 'bs-7');
        const old = await addAttempt(orderId, 2, 'CANCELLED', 'bs-8');
        const otherOrder = await addOrder();
        const stale = await addAttempt(otherOrder, 1, 'PENDING', 'bs-9');
        await db.pool.query(`UPDATE order_delivery_attempts SET created_at = CURRENT_TIMESTAMP - interval '25 hours' WHERE id = $1`, [stale]);
        const cancelledOrder = await addOrder();
        const cancelled = await addAttempt(cancelledOrder, 1, 'ALLOCATED', 'bs-10');
        remote.set('bs-9', NOT_FOUND);
        remote.set('bs-10', { status: 'cancelled', courier: { history: [{ status: 'cancelled', note: 'Order cancelled by Admin' }] } });

        expect(await biteship.pollActiveDeliveryAttempts()).toEqual({ checked: 1, changed: 1 });
        expect(await attempt(cancelled)).toMatchObject({ status: 'CANCELLED', failure_message: 'Order cancelled by Admin' });
        expect((await attempt(stale)).status).toBe('PENDING');
        expect((await attempt(old)).status).toBe('CANCELLED');
    });

    it('webhook: courier_not_found fails the attempt; a later "allocated" for it does not reopen it', async () => {
        const orderId = await addOrder();
        const first = await addAttempt(orderId, 1, 'PENDING', 'bs-4');

        await webhook({ event: 'order.status', order_id: 'bs-4', status: 'courier_not_found', updated_at: '2099-03-01T08:00:00Z' });
        expect(await attempt(first)).toMatchObject({ status: 'FAILED', provider_status: 'courier_not_found' });

        await addAttempt(orderId, 2, 'PENDING', 'bs-5'); // admin retried
        await expect(webhook({ event: 'order.status', order_id: 'bs-4', status: 'allocated', updated_at: '2099-03-01T08:05:00Z' }))
            .resolves.toEqual({ ok: true });
        expect((await attempt(first)).status).toBe('FAILED');
    });
});
