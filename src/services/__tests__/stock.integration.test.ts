import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, useTestDb } from '../../__tests__/testDb';

// Run with: TEST_DATABASE_URL=postgres://localhost/rpn_migration_test npm test
describe.skipIf(!hasTestDb)('stock & recipe services (local Postgres)', () => {
    let db: typeof import('../../config/db');
    let stock: typeof import('../stock.service');
    let recipe: typeof import('../variantRecipe.service');
    let variant: typeof import('../variant.service');

    beforeAll(async () => {
        useTestDb();
        db = await import('../../config/db');
        stock = await import('../stock.service');
        recipe = await import('../variantRecipe.service');
        variant = await import('../variant.service');
    });

    afterAll(async () => {
        await db?.pool.end();
    });

    beforeEach(async () => {
        await db.pool.query('TRUNCATE variant_recipe, stock_history, stock, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Dark Choco'), ('Vanilla'), ('Keju')`);
    });

    it('createStock + adjustStock (delta and physical count) keep history consistent', async () => {
        const s = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1, qty: 1000 });
        expect(s.qty).toBe(1000); // NUMERIC comes back as a number

        await stock.adjustStock({ stock_id: s.id, qty_change: 500, type: 'IN' });
        const counted = await stock.adjustStock({ stock_id: s.id, qty_change: 1200, type: 'OUT', is_target: true });
        expect(counted.qty).toBe(1200);

        const history = await stock.getStockHistory(s.id);
        expect(history.map(h => h.qty_change).sort()).toEqual([-300, 1000, 500].sort());
        expect(await stock.getStocks(2)).toEqual([]);
    });

    it('allows stock to go negative (stock_qty_check dropped)', async () => {
        const s = await stock.createStock({ item_name: 'Keju', unit: 'gram', store_id: 1 });
        const updated = await stock.adjustStock({ stock_id: s.id, qty_change: -50, type: 'OUT' });
        expect(updated.qty).toBe(-50);
    });

    it('concurrent adjustments do not lose updates', async () => {
        const s = await stock.createStock({ item_name: 'Gula', unit: 'gram', store_id: 1, qty: 0 });
        await Promise.all(Array.from({ length: 10 }, () => stock.adjustStock({ stock_id: s.id, qty_change: 10, type: 'IN' })));
        const [row] = await stock.getStocks(1);
        expect(row.qty).toBe(100);
    });

    it('recipe validation: gram units only, same store only', async () => {
        const kg = await stock.createStock({ item_name: 'Minyak', unit: 'kg', store_id: 1 });
        const otherStore = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 2 });
        await expect(recipe.replaceVariantRecipe(1, 1, [{ stock_id: kg.id, qty_gram: 5 }])).rejects.toThrow(/satuan/);
        await expect(recipe.replaceVariantRecipe(1, 1, [{ stock_id: otherStore.id, qty_gram: 5 }])).rejects.toThrow(/store/);
        await expect(recipe.replaceVariantRecipe(1, 1, [{ stock_id: otherStore.id, qty_gram: 0 }])).rejects.toThrow(/gram/);
    });

    it('resolveBoxCost end-to-end: flavors, HALF, 3-flavor mix', async () => {
        const tepung = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1 });
        const coklat = await stock.createStock({ item_name: 'Cokelat', unit: 'g', store_id: 1 });

        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepung.id, qty_gram: 50 }, { stock_id: coklat.id, qty_gram: 30 }]);
        await recipe.replaceVariantRecipe(2, 1, [{ stock_id: tepung.id, qty_gram: 50 }]);
        await recipe.replaceVariantRecipe(3, 1, [{ stock_id: tepung.id, qty_gram: 40 }]);

        expect(await recipe.resolveBoxCost([1], 'FULL', 1)).toEqual([
            { stock_id: tepung.id, qty_gram: 50 },
            { stock_id: coklat.id, qty_gram: 30 },
        ]);
        expect(await recipe.resolveBoxCost([1], 'HALF', 1)).toEqual([
            { stock_id: tepung.id, qty_gram: 25 },
            { stock_id: coklat.id, qty_gram: 15 },
        ]);
        expect(await recipe.resolveBoxCost([1, 2], 'FULL', 1)).toEqual([
            { stock_id: tepung.id, qty_gram: 50 },
            { stock_id: coklat.id, qty_gram: 15 },
        ]);
        expect(await recipe.resolveBoxCost([1, 2, 3], 'FULL', 1)).toEqual([
            { stock_id: tepung.id, qty_gram: 46.6667 },
            { stock_id: coklat.id, qty_gram: 10 },
        ]);
        // Recipes are per store: store 2 has none.
        expect(await recipe.resolveBoxCost([1], 'FULL', 2)).toEqual([]);
    });

    it('stock-in with total price sets price_per_unit and drives HPP', async () => {
        const tepung = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1 });
        // "Tepung 5 kg = Rp 700.000" → Rp 140 / gram
        const updated = await stock.adjustStock({ stock_id: tepung.id, qty_change: 5000, type: 'IN', total_price: 700000 });
        expect(updated.price_per_unit).toBe(140);

        // Later stock-in without price keeps the last known price.
        const again = await stock.adjustStock({ stock_id: tepung.id, qty_change: 100, type: 'IN' });
        expect(again.price_per_unit).toBe(140);

        // Price is only allowed on a positive stock-in.
        await expect(stock.adjustStock({ stock_id: tepung.id, qty_change: 10, type: 'OUT', total_price: 5 })).rejects.toThrow(/stok masuk/);
        await expect(stock.adjustStock({ stock_id: tepung.id, qty_change: 5000, type: 'IN', is_target: true, total_price: 5 })).rejects.toThrow(/stok masuk/);

        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepung.id, qty_gram: 50 }]);
        expect((await recipe.getVariantHpp([1], 'FULL', 1)).hpp).toBe(7000);
        expect((await recipe.getVariantHpp([1], 'HALF', 1)).hpp).toBe(3500);

        const history = await stock.getStockHistory(tepung.id);
        expect(history.find(h => Number(h.qty_change) === 5000)?.total_price).toBe(700000);
    });

    it('edit/delete stock items: blocked while a recipe uses them', async () => {
        const tepung = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1 });
        expect((await stock.updateStock(tepung.id, { item_name: 'Tepung Terigu' })).item_name).toBe('Tepung Terigu');

        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepung.id, qty_gram: 50 }]);
        await expect(stock.updateStock(tepung.id, { unit: 'kg' })).rejects.toMatchObject({ status: 409 });
        await expect(stock.deleteStock(tepung.id)).rejects.toMatchObject({ status: 409 });

        await recipe.replaceVariantRecipe(1, 1, []);
        expect((await stock.updateStock(tepung.id, { unit: 'kg' })).unit).toBe('kg');
        await stock.deleteStock(tepung.id);
        await expect(stock.deleteStock(tepung.id)).rejects.toMatchObject({ status: 404 });
    });

    it('copies recipes to another store, matching ingredients by name and creating missing ones', async () => {
        const coklat1 = await stock.createStock({ item_name: 'Cokelat', unit: 'gram', store_id: 1 });
        const keju1 = await stock.createStock({ item_name: 'Keju', unit: 'gram', store_id: 1 });
        const coklat2 = await stock.createStock({ item_name: 'cokelat', unit: 'gram', store_id: 2 }); // same ingredient, other case
        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: coklat1.id, qty_gram: 100 }, { stock_id: keju1.id, qty_gram: 20 }]);
        await recipe.replaceVariantRecipe(2, 1, [{ stock_id: coklat1.id, qty_gram: 100 }]);

        const one = await recipe.copyVariantRecipes(1, 2, [1]);
        expect(one).toEqual({ copied_variants: 1, created_stock: ['Keju'] });
        const store2 = await recipe.getVariantRecipes({ store_id: 2, variant_id: 1 });
        expect(store2.map(r => [r.item_name, r.qty_gram]).sort()).toEqual([['Keju', 20], ['cokelat', 100]]);
        expect(store2.find(r => r.item_name === 'cokelat')?.stock_id).toBe(coklat2.id);

        // Copy everything; Keju now exists at store 2 so nothing new is created, and re-copying replaces.
        expect(await recipe.copyVariantRecipes(1, 2)).toEqual({ copied_variants: 2, created_stock: [] });
        expect((await recipe.getVariantRecipes({ store_id: 2 })).length).toBe(3);

        await expect(recipe.copyVariantRecipes(1, 1)).rejects.toThrow(/tidak boleh sama/);
        await expect(recipe.copyVariantRecipes(2, 1, [3])).rejects.toThrow(/Belum ada resep/);
    });

    it('suggests previously used grams per ingredient (most used first, across stores)', async () => {
        const coklat = await stock.createStock({ item_name: 'Cokelat', unit: 'gram', store_id: 1 });
        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: coklat.id, qty_gram: 100 }]);
        await recipe.replaceVariantRecipe(2, 1, [{ stock_id: coklat.id, qty_gram: 100 }]);
        await recipe.replaceVariantRecipe(3, 1, [{ stock_id: coklat.id, qty_gram: 80 }]);
        const s = await recipe.getGramSuggestions();
        expect(s['cokelat']).toEqual([{ qty_gram: 100, uses: 2 }, { qty_gram: 80, uses: 1 }]);
    });

    it('menu box CRUD follows the product rules (FULL 3 rasa, HALF 1 rasa, porsi 0.5)', async () => {
        await db.pool.query('TRUNCATE menu RESTART IDENTITY CASCADE');
        const menu = await import('../menu.service');
        const full = await menu.createMenu({ name: 'FULL', price: 65000 });
        const half = await menu.createMenu({ name: 'HALF', price: 35000 });
        expect(full).toMatchObject({ max_flavors: 3, box_multiplier: 1, weight_gram: 1000 });
        expect(half).toMatchObject({ max_flavors: 1, box_multiplier: 0.5, weight_gram: 500 });

        await expect(menu.createMenu({ name: 'FULL', price: 1 })).rejects.toMatchObject({ status: 409 });
        await expect(menu.createMenu({ name: 'HAMPERS', price: 1 })).rejects.toMatchObject({ status: 400 });
        await expect(menu.updateMenu(half.id, { max_flavors: 2 })).rejects.toThrow(/1–1/);
        await expect(menu.updateMenu(full.id, { max_flavors: 4 })).rejects.toThrow(/1–3/);
        await expect(menu.updateMenu(full.id, { name: 'HALF' })).rejects.toMatchObject({ status: 400 });
        expect((await menu.updateMenu(full.id, { max_flavors: 2, price: 70000 }))).toMatchObject({ max_flavors: 2, price: 70000 });

        const catalog = await recipe.loadVariantCatalog();
        expect(catalog.maxFlavors.get('HALF')).toBe(1);
        await menu.deleteMenu(half.id);
        await expect(menu.deleteMenu(half.id)).rejects.toMatchObject({ status: 404 });
    });

    it('variant CRUD: unique names (case-insensitive), used flavors can only be deactivated', async () => {
        const variant = await import('../variant.service');
        const v = await variant.createVariant({ variant_name: '  Choco   Cheese ', store_ids: [1, 2] });
        expect(v).toMatchObject({ variant_name: 'Choco Cheese', is_active: true, store_ids: [1, 2] });
        await expect(variant.createVariant({ variant_name: 'choco cheese' })).rejects.toMatchObject({ status: 409 });
        await expect(variant.createVariant({ variant_name: '' })).rejects.toMatchObject({ status: 400 });
        expect((await variant.updateVariant(v.id, { variant_name: 'Choco Cheese', is_active: false })).is_active).toBe(false);

        // Used in an order → delete refused, deactivate still possible.
        await db.pool.query(`INSERT INTO orders (customer_name, customer_phone, pickup_date, status, store_id) VALUES ('A', '0812', '2099-01-05', 'UNPAID', 1)`);
        await db.pool.query(`INSERT INTO order_items (order_id, box_type, name, qty) VALUES (currval('orders_id_seq'), 'FULL', 'Choco Cheese', 1)`);
        await db.pool.query(`INSERT INTO order_item_variants (order_item_id, variant_id) VALUES (currval('order_items_id_seq'), $1)`, [v.id]);
        await expect(variant.deleteVariant(v.id)).rejects.toThrow(/Nonaktifkan/);

        const unused = await variant.createVariant({ variant_name: 'Vanila Cheese' });
        await variant.deleteVariant(unused.id);
        await expect(variant.deleteVariant(unused.id)).rejects.toMatchObject({ status: 404 });
        await db.pool.query('TRUNCATE orders, order_items, order_item_variants RESTART IDENTITY CASCADE');
    });

    it('setup status reflects what a store still needs', async () => {
        const { getSetupStatus } = await import('../setup.service');
        const steps = await getSetupStatus(1);
        const byKey = Object.fromEntries(steps.map(s => [s.key, s]));
        expect(byKey.menu.state).toBe('done');       // FULL + HALF with price, available in stores {1,2} (column default)
        expect(byKey.variants.state).toBe('done');   // 3 active variants from beforeEach
        expect(byKey.recipes.state).toBe('todo');    // none of them has a recipe yet
        expect(byKey.quota.state).toBe('todo');

        await db.pool.query(`UPDATE menu SET store_ids = '{2}' WHERE name = 'HALF'`);
        expect((await getSetupStatus(1)).find(s => s.key === 'menu')?.state).toBe('partial');
        expect(byKey.salary.href).toBe('/config/salary');
    });
});
