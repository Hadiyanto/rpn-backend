import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

// Fase 10: every service moved from supabase-js to pg must keep the response shape the
// frontend relies on (numbers as numbers, DATE as 'YYYY-MM-DD', TIMESTAMP as 'YYYY-MM-DDTHH:mm:ss…').
describe.skipIf(!hasTestDb)('services on pg (shape parity & behaviour)', () => {
    let db: typeof import('../../config/db');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        await db.pool.query(`TRUNCATE capital, debt, pengeluaran, penjualan, transactions, salary_config, daily_salary,
            orders, order_items, daily_quota, hourly_quota, menu, variant, push_subscriptions RESTART IDENTITY CASCADE`);
    });

    const isTimestampString = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);

    it('capital & debt CRUD: numeric → number, partial updates keep other columns, 404 on unknown id', async () => {
        const { createCapital, updateCapital, getCapitals, deleteCapital } = await import('../capital.service');
        const cap = await createCapital({ amount: 1500000, note: 'Modal awal' });
        expect(cap.amount).toBe(1500000);
        expect(isTimestampString(cap.created_at)).toBe(true);
        const upd = await updateCapital(cap.id, { amount: 2000000, note: undefined });
        expect(upd).toMatchObject({ amount: 2000000, note: 'Modal awal' });
        expect(await getCapitals()).toHaveLength(1);
        await expect(updateCapital(999, { amount: 1 })).rejects.toMatchObject({ status: 404 });
        await deleteCapital(cap.id);
        expect(await getCapitals()).toHaveLength(0);

        const { createDebt, updateDebt } = await import('../debt.service');
        const debt = await createDebt({ source: 'Bank', total_amount: 1000, remaining_amount: 800 });
        expect(debt.status).toBe('ACTIVE');
        expect((await updateDebt(debt.id, { status: 'PAID' })).remaining_amount).toBe(800);
    });

    it('pengeluaran: empty date → DB default, date stays a string', async () => {
        const { createPengeluaran, getPengeluaran } = await import('../pengeluaran.service');
        const row = await createPengeluaran({ name: 'Gas', price: 25000, date: '' });
        expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(row.price).toBe(25000);
        expect((await getPengeluaran())[0].name).toBe('Gas');
    });

    it('POS transaction: header + lines atomically, sequential order numbers under concurrency, menu embed', async () => {
        await db.pool.query(`INSERT INTO menu (name, price) VALUES ('FULL', 65000)`);
        const { createTransaction } = await import('../transaction.service');
        const { getPenjualanByTransaction } = await import('../penjualan.service');
        const item = { menu_id: 1, type: 'FULL', topping: ['Keju'], qty: 1, price: 65000, total_price: 65000 };

        const results = await Promise.all(Array.from({ length: 5 }, () => createTransaction([item], 65000, 'Walk-in')));
        expect(results.map(r => r.order_number).sort()).toEqual(['RPN-0000001', 'RPN-0000002', 'RPN-0000003', 'RPN-0000004', 'RPN-0000005']);

        const lines = await getPenjualanByTransaction(results[0].id);
        expect(lines[0]).toMatchObject({ menu: { name: 'FULL' }, variant: '["Keju"]', quantity: 1, price: 65000 });

        // A failing line rolls the header back too.
        await expect(createTransaction([{ ...item, qty: null }], 1, 'x')).rejects.toBeTruthy();
        expect((await db.pool.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n).toBe(5);
    });

    it('salary: config replace is atomic, preview counts HALF as 0.5, daily upsert', async () => {
        const salary = await import('../salary.service');
        await salary.updateSalaryConfig([{ min_box: 1, max_box: 10, amount: 5000, is_fixed: false }]);
        await expect(salary.updateSalaryConfig([{ min_box: null as any, max_box: null, amount: 1, is_fixed: false }])).rejects.toBeTruthy();
        expect(await salary.getSalaryConfig()).toHaveLength(1); // old config survived the failed replace

        await db.pool.query(`INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id) VALUES ('A', '0812', '2099-01-05', 'PAID', 1)`);
        await db.pool.query(`INSERT INTO order_items (order_id, box_type, name, qty) VALUES (1, 'FULL', 'x', 2), (1, 'HALF', 'y', 3)`);
        const preview = await salary.calculateSalaryPreview('2099-01-05');
        expect(preview).toMatchObject({ totalBoxesRaw: 3.5, totalBoxesRounded: 4, totalSalary: 20000 });

        await salary.generateDailySalary('2099-01-05');
        const saved = await salary.generateDailySalary('2099-01-05');
        expect(saved).toMatchObject({ date: '2099-01-05', total_boxes: 4, total_salary: 20000 });
        expect(await salary.getDailySalaries()).toHaveLength(1);
    });

    it('finance summary from SQL aggregates', async () => {
        await db.pool.query(`INSERT INTO menu (name, price) VALUES ('FULL', 65000), ('HALF', 35000)`);
        await db.pool.query(`INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id) VALUES ('A', '0812', '2099-01-05', 'DONE', 1), ('B', '0812', '2099-01-05', 'UNPAID', 1)`);
        await db.pool.query(`INSERT INTO order_items (order_id, box_type, name, qty) VALUES (1, 'FULL', 'x', 2), (1, 'HALF', 'y', 1), (2, 'FULL', 'z', 9)`);
        await db.pool.query(`INSERT INTO pengeluaran (name, price, date) VALUES ('Gas', 30000, '2099-01-05')`);
        await db.pool.query(`INSERT INTO debt (source, total_amount, remaining_amount, status) VALUES ('Bank', 100, 60, 'ACTIVE')`);
        const { getWeeklySummary } = await import('../finance.service');
        expect(await getWeeklySummary('2099-01-01', '2099-01-07')).toMatchObject({
            totalRevenue: 165000, totalCost: 30000, grossProfit: 135000, totalBoxes: 3, remainingDebt: 60,
        });
    });

    it('menu / variant / store: list, partial update, 404', async () => {
        const menu = await import('../menu.service');
        const m = await menu.createMenu({ name: 'FULL', price: 65000, description: 'Box besar' });
        expect(m.price).toBe(65000);
        expect((await menu.updateMenu(m.id, { price: 70000 })).description).toBe('Box besar');
        await expect(menu.updateMenu(999, { price: 1 })).rejects.toMatchObject({ status: 404 });

        const variant = await import('../variant.service');
        const v = await variant.createVariant({ variant_name: 'Keju' });
        expect((await variant.updateVariant(v.id, { store_ids: [1] })).store_ids).toEqual([1]);

        const store = await import('../store.service');
        const stores = await store.getStores();
        expect(stores[0]).toMatchObject({ id: 1, latitude: expect.any(Number) });
        const updated = await store.updateStore(1, { bank_account_name: 'Test' });
        expect(updated).toMatchObject({ bank_account_name: 'Test', name: 'RPN Store Pancoran' });
    });

    it('daily & hourly quota lists; duplicate date → pg 23505; getOrders filters + shape; payment check → 23514', async () => {
        const daily = await import('../dailyQuota.service');
        await daily.createDailyQuota('2099-01-05', 10, 1);
        await expect(daily.createDailyQuota('2099-01-05', 10, 1)).rejects.toMatchObject({ code: '23505' });
        expect((await daily.getDailyQuotaByDate('2099-01-05', 1))).toMatchObject({ date: '2099-01-05', qty: 10, remaining_qty: 10 });

        const hourly = await import('../hourlyQuota.service');
        await hourly.upsertHourlyQuota('12:00', 5, 1, true);
        expect(await hourly.getHourlyQuotas(1)).toMatchObject([{ time_str: '12:00', qty: 5, is_active: true }]);

        await db.pool.query(`INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id) VALUES
            ('A', '0812', '2099-01-05', 'PAID', 1), ('B', '0812', '2099-01-06', 'UNPAID', 2)`);
        await db.pool.query(`INSERT INTO order_items (order_id, box_type, name, qty) VALUES (1, 'FULL', 'x', 2)`);
        const orders = await import('../order.service');
        const all = await orders.getOrders();
        expect(all.map((o: any) => o.id)).toEqual([1, 2]);
        expect(all[0].items).toEqual([{ id: 1, box_type: 'FULL', name: 'x', qty: 2, variant_ids: [] }]);
        expect(all[1].items).toEqual([]);
        expect((await orders.getOrders({ status: 'paid' })).map((o: any) => o.id)).toEqual([1]);
        expect((await orders.getOrders({ store_id: 2 })).map((o: any) => o.id)).toEqual([2]);
        expect((await orders.getOrders({ day: 'SENIN' })).map((o: any) => o.id)).toEqual([1]); // 2099-01-05 is a Monday

        await expect(orders.updatePaymentMethod(1, 'BITCOIN')).rejects.toMatchObject({ code: '23514' });
        expect((await orders.updatePaymentMethod(1, 'CASH')).payment_method).toBe('CASH');
    });

    it('user role & push subscriptions', async () => {
        const { getUserRoleOrDefault } = await import('../userRole.service');
        expect((await getUserRoleOrDefault('not-a-uuid')).role).toBe('staff');

        const push = await import('../push.service');
        await push.saveSubscription({ endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } });
        const again = await push.saveSubscription({ endpoint: 'https://push/1', keys: { p256dh: 'c', auth: 'd' } });
        expect(again).toMatchObject({ p256dh: 'c', auth: 'd' });
        await push.deleteSubscription('https://push/1');
        expect((await db.pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(0);
    });
});
