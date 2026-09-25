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
        await db.pool.query('TRUNCATE variant_recipe, variant_components, stock_history, stock, variant, menu RESTART IDENTITY CASCADE');
        await db.pool.query(`INSERT INTO menu (name, price, box_multiplier, max_flavors) VALUES ('FULL', 65000, 1, 3), ('HALF', 35000, 0.5, 1)`);
        await db.pool.query(`INSERT INTO variant (variant_name) VALUES ('Dark Choco'), ('Vanilla'), ('Keju'), ('Mix 3 (Choco, Vanilla, Keju)')`);
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

    it('resolveBoxCost end-to-end: flavors, HALF, preset mix', async () => {
        const tepung = await stock.createStock({ item_name: 'Tepung', unit: 'gram', store_id: 1 });
        const coklat = await stock.createStock({ item_name: 'Cokelat', unit: 'g', store_id: 1 });

        await recipe.replaceVariantRecipe(1, 1, [{ stock_id: tepung.id, qty_gram: 50 }, { stock_id: coklat.id, qty_gram: 30 }]);
        await recipe.replaceVariantRecipe(2, 1, [{ stock_id: tepung.id, qty_gram: 50 }]);
        await recipe.replaceVariantRecipe(3, 1, [{ stock_id: tepung.id, qty_gram: 40 }]);
        await recipe.replaceVariantComponents(4, [1, 2, 3]);

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
        expect(await recipe.resolveBoxCost([4], 'FULL', 1)).toEqual([
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

    it('variant components: rules and exposure via getVariants / catalog', async () => {
        await expect(recipe.replaceVariantComponents(4, [4])).rejects.toThrow(/dirinya sendiri/);
        await recipe.replaceVariantComponents(4, [1, 2, 3]);
        await expect(recipe.replaceVariantComponents(1, [2])).rejects.toThrow(/komponen paket lain/);

        const variants = await variant.getVariants();
        expect(variants.find(v => v.id === 4)?.component_ids).toEqual([1, 2, 3]);
        expect(variants.find(v => v.id === 1)?.component_ids).toEqual([]);

        const catalog = await recipe.loadVariantCatalog();
        expect([...catalog.presetIds]).toEqual([4]);
        expect(catalog.maxFlavors.get('FULL')).toBe(3);

        await recipe.replaceVariantComponents(4, []);
        expect((await recipe.loadVariantCatalog()).presetIds.size).toBe(0);
    });
});
