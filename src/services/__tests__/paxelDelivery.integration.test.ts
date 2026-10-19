import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));
vi.mock('../push.service', () => ({ sendPushToAll: vi.fn(async () => undefined) }));

// Biteship rates/orders, shaped like the sandbox responses of 2026-10-19 (docs/plan-paxel-whitelist.md).
const AREAS = {
    bandung: { administrative_division_level_1_name: 'Jawa Barat', administrative_division_level_2_name: 'Bandung' },
    depok: { administrative_division_level_1_name: 'Jawa Barat', administrative_division_level_2_name: 'Depok' },
};
let destination: unknown = AREAS.bandung;
let paxelFails = false;
let instantFails: false | 'no-courier' | 'down' = false;
const calls: Array<{ path: string; body: any }> = [];
const rate = (courier_code: string, courier_service_code: string, price: number) =>
    ({ courier_code, courier_service_code, courier_name: courier_code, courier_service_name: courier_service_code, duration: '1 - 3 hours', price });
vi.mock('../../utils/biteship', () => ({
    biteshipGet: vi.fn(async () => ({ areas: [] })),
    biteshipPost: vi.fn(async (path: string, body: any) => {
        calls.push({ path, body });
        if (path === '/orders') return { id: 'bs-paxel-1', status: 'confirmed', courier: { link: 'https://track.test/1' } };
        if (body.couriers === 'paxel') {
            if (paxelFails) throw new Error('Biteship down');
            return { destination, pricing: [rate('paxel', 'small', 21500), rate('paxel', 'medium', 36500), rate('paxel', 'large', 44500)] };
        }
        if (instantFails === 'no-courier') throw new Error('No courier available for requested location. Please activate other courier option to receive other pricing rate.');
        if (instantFails === 'down') throw new Error('fetch failed');
        return { destination, pricing: [rate('grab', 'instant', 19000), rate('grab', 'same_day', 19000), rate('lalamove', 'motorcycle', 13200)] };
    }),
}));

const DATE = '2099-05-01';
const WHITELISTED = '081200000004';
const OTHER = '081299999999';

describe.skipIf(!hasTestDb)('Paxel Small for whitelisted customers outside Jabodetabek (local Postgres)', () => {
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
        delete process.env.PAXEL_WHITELIST;
        await db?.pool.end();
    });

    beforeEach(async () => {
        process.env.PAXEL_WHITELIST = '0812-0000-0004';
        delete process.env.SELECTED_COURIER;
        destination = AREAS.bandung;
        paxelFails = false;
        instantFails = false;
        calls.length = 0;
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, order_delivery_attempts, daily_quota, hourly_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors, weight_gram, length_cm, width_cm, height_cm)
                             VALUES ('FULL', 60000, 1, 3, 600, 20, 10, 5), ('HALF', 32500, 0.5, 1, 350, 10, 10, 5)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Choco')`);
        await db.pool.query(`INSERT INTO variant_price (variant_id, store_id, price_full, price_half) SELECT v.id, s.id, 60000, 32500 FROM variant v CROSS JOIN stores s`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 50, 1)`, [DATE]);
    });

    const pesanan = [{ box_type: 'FULL' as const, name: 'Choco', qty: 2, variant_ids: [1] }];
    const options = (customer_phone: string) =>
        orders.storeDeliveryOptionsForOrder({ store_id: 1, pesanan, customer_phone, delivery_lat: -6.9175, delivery_lng: 107.6191 });
    const offered = async (customer_phone: string) => (await options(customer_phone)).map(o => `${o.courier_company}/${o.courier_type}`);

    it('whitelisted + outside Jabodetabek: Paxel Small (not medium/large) next to the usual couriers, quoted without dimensions', async () => {
        expect(await offered('+62 812 0000 0004')).toEqual(['lalamove/motorcycle', 'grab/instant', 'paxel/small']);

        const paxelCall = calls.find(c => c.body.couriers === 'paxel')!;
        const instantCall = calls.find(c => c.body.couriers !== 'paxel')!;
        expect(Object.keys(paxelCall.body.items[0]).sort()).toEqual(['name', 'quantity', 'value', 'weight']);
        expect(paxelCall.body.items[0]).toMatchObject({ value: 60000, weight: 600, quantity: 2 });
        expect(instantCall.body.items[0]).toMatchObject({ length: 20, width: 10, height: 5, weight: 600 });
    });

    it('no Paxel inside Jabodetabek, for other numbers, with an empty whitelist, or when the destination is unknown', async () => {
        destination = AREAS.depok;
        expect(await offered(WHITELISTED)).not.toContain('paxel/small');

        destination = AREAS.bandung;
        calls.length = 0;
        expect(await offered(OTHER)).toEqual(['lalamove/motorcycle', 'grab/instant']);
        expect(calls.some(c => c.body.couriers === 'paxel')).toBe(false); // not even asked

        process.env.PAXEL_WHITELIST = '';
        expect(await offered(WHITELISTED)).not.toContain('paxel/small');

        process.env.PAXEL_WHITELIST = WHITELISTED;
        destination = undefined;
        expect(await offered(WHITELISTED)).not.toContain('paxel/small');
    });

    it('a failed Paxel quote never hides the other couriers', async () => {
        paxelFails = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await offered(WHITELISTED)).toEqual(['lalamove/motorcycle', 'grab/instant']);
    });

    it('no instant courier to the destination (e.g. Bandung): Paxel alone for a whitelisted number, the usual error otherwise', async () => {
        instantFails = 'no-courier';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await offered(WHITELISTED)).toEqual(['paxel/small']);
        // No courier at all: a clear 409 (a 502 would be replaced by Cloudflare's "error code: 502" page).
        const noCourier = { status: 409, message: 'Belum ada kurir yang bisa mengantar ke lokasi ini. Coba geser titik lokasi atau pilih ambil di toko.' };
        await expect(options(OTHER)).rejects.toMatchObject(noCourier);

        destination = AREAS.depok; // Paxel not allowed here → nothing left
        await expect(options(WHITELISTED)).rejects.toMatchObject(noCourier);

        // A real Biteship outage stays a 502.
        instantFails = 'down';
        await expect(options(OTHER)).rejects.toMatchObject({ status: 502 });
    });

    const order = (customer_phone: string) => orders.createOrder({
        customer_name: 'Budi', customer_phone, pickup_date: DATE, store_id: 1, payment_method: 'TRANSFER', pesanan,
        delivery_method: 'store_delivery', delivery_lat: -6.9175, delivery_lng: 107.6191,
        delivery_address: 'Jl. Asia Afrika, Bandung', delivery_courier_company: 'paxel', delivery_courier_type: 'small',
    });

    it('POST /order re-quotes: Paxel from a number outside the whitelist is refused, a whitelisted one is charged the Paxel fee', async () => {
        await expect(order(OTHER)).rejects.toMatchObject({ status: 409 });

        const created = await order(WHITELISTED);
        expect(created).toMatchObject({ delivery_courier_company: 'paxel', delivery_courier_type: 'small' });
        expect(Number(created.delivery_fee)).toBe(21500);
    });

    it('the courier booking for a Paxel order is sent without dimensions', async () => {
        const created = await order(WHITELISTED);
        await db.pool.query(`UPDATE orders SET status = 'DONE' WHERE id = $1`, [created.id]);
        calls.length = 0;

        const result = await biteship.createBiteshipDispatch(await orders.getOrderById(created.id));
        expect(result).toMatchObject({ status: 'created', biteship_order_id: 'bs-paxel-1' });
        const booking = calls.find(c => c.path === '/orders')!.body;
        expect(booking).toMatchObject({ courier_company: 'paxel', courier_type: 'small', delivery_type: 'now' });
        expect(Object.keys(booking.items[0]).sort()).toEqual(['description', 'name', 'quantity', 'value', 'weight']);
        expect(booking.items[0]).toMatchObject({ description: 'RPN FULL', value: 60000, weight: 600, quantity: 2 });
    });
});
