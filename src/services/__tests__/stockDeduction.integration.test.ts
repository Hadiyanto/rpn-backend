import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';
import { createFakeRedis } from '../../__tests__/fakeRedis';

const fakeRedis = createFakeRedis();
vi.mock('../../utils/redis', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/redis')>()),
    redis: fakeRedis,
}));

const DATE = '2099-01-05';

// Design-doc verification scenario (Fase 06), end-to-end against a local Postgres.
describe.skipIf(!hasTestDb)('auto stock deduction lifecycle', () => {
    let db: typeof import('../../config/db');
    let orders: typeof import('../order.service');
    let stock: typeof import('../stock.service');
    let recipe: typeof import('../variantRecipe.service');
    let deduction: typeof import('../stockDeduction.service');
    let tepungId: number;

    const tepungQty = async () => Number((await db.pool.query('SELECT qty FROM stock WHERE id = $1', [tepungId])).rows[0].qty);
    const base = { customer_name: 'Budi', customer_phone: '081234567890', pickup_date: DATE, store_id: 1 };

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        orders = await import('../order.service');
        stock = await import('../stock.service');
        recipe = await import('../variantRecipe.service');
        deduction = await import('../stockDeduction.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        fakeRedis.store.clear();
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants, variant_recipe, variant_components, stock_history, stock, daily_quota, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Dark Choco'), ('Vanilla')`);
        await db.pool.query(`INSERT INTO daily_quota (date, qty, store_id) VALUES ($1, 100, 1)`, [DATE]);

        // Resep: Dark Choco = 50 g Tepung. Stok masuk 5000 g @ Rp 700.000. Vanilla: tanpa Tepung.
        const tepung = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1 });
        tepungId = tepung.id;
        await stock.adjustStock({ stock_id: tepungId, qty_change: 5000, type: 'IN', total_price: 700000 });
        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepungId, qty_gram: 50 }]);
    });

    it('2× FULL Dark Choco → −100 g, history OUT with order_id', async () => {
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 2, variant_ids: [1] }] });
        expect(await tepungQty()).toBe(4900);

        const { rows } = await db.pool.query('SELECT type, qty_change, order_id, notes FROM stock_history WHERE order_id = $1', [order.id]);
        expect(rows).toEqual([{ type: 'OUT', qty_change: -100, order_id: order.id, notes: `Order #${order.id}` }]);
    });

    it('FULL mix Dark Choco + Vanilla → −25 g; HALF Dark Choco → −25 g', async () => {
        await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Mix Dark Choco Dan Vanilla', qty: 1, variant_ids: [1, 2] }] });
        expect(await tepungQty()).toBe(4975);
        await orders.createOrder({ ...base, pesanan: [{ box_type: 'HALF', name: 'Dark Choco', qty: 1, variant_ids: [1] }] });
        expect(await tepungQty()).toBe(4950);
    });

    it('cancel → +100, un-cancel → −100, cancelling twice does not double', async () => {
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 2, variant_ids: [1] }] });
        expect(await tepungQty()).toBe(4900);

        await orders.updateOrderStatus(order.id, 'CANCELLED');
        expect(await tepungQty()).toBe(5000);
        await orders.updateOrderStatus(order.id, 'CANCELLED');
        expect(await tepungQty()).toBe(5000);

        await orders.updateOrderStatus(order.id, 'UNPAID');
        expect(await tepungQty()).toBe(4900);
        await orders.updateOrderStatus(order.id, 'PAID'); // not a cancel transition
        expect(await tepungQty()).toBe(4900);
    });

    it('editing items reverses the old deduction and applies the new one', async () => {
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 2, variant_ids: [1] }] });
        await orders.updateOrder(order.id, { pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 5, variant_ids: [1] }] });
        expect(await tepungQty()).toBe(4750);

        // Editing a cancelled order must not deduct anything.
        await orders.updateOrderStatus(order.id, 'CANCELLED');
        await orders.updateOrder(order.id, { pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 1, variant_ids: [1] }] });
        expect(await tepungQty()).toBe(5000);
    });

    it('stock may go negative; the order still succeeds', async () => {
        await stock.adjustStock({ stock_id: tepungId, qty_change: 30, type: 'OUT', is_target: true });
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 1, variant_ids: [1] }] });
        expect(order.id).toBeGreaterThan(0);
        expect(await tepungQty()).toBe(-20);
    });

    it('apply is idempotent; recalculate picks up a changed recipe', async () => {
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 1, variant_ids: [1] }] });
        expect((await deduction.applyOrderStock(order.id)).reason).toBe('already applied');
        expect(await tepungQty()).toBe(4950);

        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepungId, qty_gram: 80 }]);
        await deduction.recalculateOrderStock(order.id);
        expect(await tepungQty()).toBe(4920);
    });

    it('parallel reversals/applies for one order serialize on the order lock', async () => {
        const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 2, variant_ids: [1] }] });
        await Promise.all(Array.from({ length: 5 }, () => deduction.reverseOrderStock(order.id)));
        expect(await tepungQty()).toBe(5000);
        await Promise.all(Array.from({ length: 5 }, () => deduction.applyOrderStock(order.id)));
        expect(await tepungQty()).toBe(4900);
    });

    it('legacy items without variant_ids are not deducted', async () => {
        await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 3 }] });
        expect(await tepungQty()).toBe(5000);
    });

    it('a broken stock deduction never fails the order', async () => {
        // Break recipe lookups for real (test DB only), so the deduction throws inside its transaction.
        await db.pool.query('ALTER TABLE variant_recipe RENAME TO variant_recipe_broken');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const order = await orders.createOrder({ ...base, pesanan: [{ box_type: 'FULL', name: 'Dark Choco', qty: 1, variant_ids: [1] }] });
            expect(order.id).toBeGreaterThan(0);
            expect((await db.pool.query('SELECT 1 FROM orders WHERE id = $1', [order.id])).rowCount).toBe(1);
            expect(errors.mock.calls.some(args => String(args[0]).startsWith('[stock] apply failed'))).toBe(true);
            expect(await tepungQty()).toBe(5000);
        } finally {
            errors.mockRestore();
            await db.pool.query('ALTER TABLE variant_recipe_broken RENAME TO variant_recipe');
        }
    });
});
