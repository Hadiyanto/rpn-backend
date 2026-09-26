import { describe, expect, it } from 'vitest';
import { checkVariantSelection, computeBoxCost, computeHpp, isGramUnit, type RecipeLine, type VariantCatalog } from '../variantRecipe.service';
import { ValidationError } from '../../utils/validation';

// Stock ids: 1 = Tepung, 2 = Cokelat, 3 = Keju
const DARK_CHOCO = 10;
const VANILLA = 11;
const CHEESE = 12;

const recipes = new Map<number, RecipeLine[]>([
    [DARK_CHOCO, [{ stock_id: 1, qty_gram: 50 }, { stock_id: 2, qty_gram: 30 }]],
    [VANILLA, [{ stock_id: 1, qty_gram: 50 }]],
    [CHEESE, [{ stock_id: 1, qty_gram: 40 }, { stock_id: 3, qty_gram: 60 }]],
]);

describe('computeBoxCost', () => {
    it('base recipe is added once per box, scaled by box_multiplier, not split by flavor', () => {
        // 4 = T.Panir 100 g, 5 = T.Sasa not measured yet (0 g → ignored)
        const base = [{ stock_id: 4, qty_gram: 100 }, { stock_id: 5, qty_gram: 0 }];
        expect(computeBoxCost([DARK_CHOCO, VANILLA], 1, recipes, base)).toEqual([
            { stock_id: 1, qty_gram: 50 },
            { stock_id: 2, qty_gram: 15 },
            { stock_id: 4, qty_gram: 100 },
        ]);
        expect(computeBoxCost([VANILLA], 0.5, recipes, base)).toEqual([
            { stock_id: 1, qty_gram: 25 },
            { stock_id: 4, qty_gram: 50 },
        ]);
        expect(computeBoxCost([], 1, recipes, base)).toEqual([]);
    });

    it('single flavor FULL box uses the full recipe', () => {
        expect(computeBoxCost([DARK_CHOCO], 1, recipes)).toEqual([
            { stock_id: 1, qty_gram: 50 },
            { stock_id: 2, qty_gram: 30 },
        ]);
    });

    it('HALF box scales by box_multiplier', () => {
        expect(computeBoxCost([DARK_CHOCO], 0.5, recipes)).toEqual([
            { stock_id: 1, qty_gram: 25 },
            { stock_id: 2, qty_gram: 15 },
        ]);
    });

    it('2-flavor mix gives each flavor half of its recipe', () => {
        // Tepung: 50/2 + 50/2 = 50, Cokelat: 30/2 = 15
        expect(computeBoxCost([DARK_CHOCO, VANILLA], 1, recipes)).toEqual([
            { stock_id: 1, qty_gram: 50 },
            { stock_id: 2, qty_gram: 15 },
        ]);
    });

    it('3-flavor FULL mix gives each flavor 1/3 of its recipe', () => {
        // Tepung: (50+50+40)/3 = 46.6667, Cokelat: 30/3 = 10, Keju: 60/3 = 20
        expect(computeBoxCost([DARK_CHOCO, VANILLA, CHEESE], 1, recipes)).toEqual([
            { stock_id: 1, qty_gram: 46.6667 },
            { stock_id: 2, qty_gram: 10 },
            { stock_id: 3, qty_gram: 20 },
        ]);
    });

    it('flavors without a recipe still count toward 1/N but add nothing', () => {
        // Vanilla has recipe, 99 has none → Tepung 50/2 = 25
        expect(computeBoxCost([VANILLA, 99], 1, recipes)).toEqual([{ stock_id: 1, qty_gram: 25 }]);
    });

    it('no variants → no usage', () => {
        expect(computeBoxCost([], 1, recipes)).toEqual([]);
    });
});

describe('checkVariantSelection', () => {
    const catalog: VariantCatalog = {
        activeIds: new Set([DARK_CHOCO, VANILLA, CHEESE, 13]),
        maxFlavors: new Map([['FULL', 3], ['HALF', 1]]),
    };

    it('falls back to the product rules when a box has no menu row (FULL 3, HALF 1)', () => {
        const bare: VariantCatalog = { activeIds: catalog.activeIds, maxFlavors: new Map() };
        expect(checkVariantSelection([DARK_CHOCO, VANILLA, CHEESE], 'FULL', bare)).toHaveLength(3);
        expect(() => checkVariantSelection([DARK_CHOCO, VANILLA], 'HALF', bare)).toThrow(/maksimal 1 rasa/);
    });

    it('accepts valid selections', () => {
        expect(checkVariantSelection([DARK_CHOCO, VANILLA], 'FULL', catalog)).toEqual([DARK_CHOCO, VANILLA]);
        expect(checkVariantSelection([DARK_CHOCO, VANILLA, CHEESE], 'FULL', catalog)).toEqual([DARK_CHOCO, VANILLA, CHEESE]);
        expect(checkVariantSelection(['11'], 'HALF', catalog)).toEqual([VANILLA]);
    });

    it.each([
        ['empty', [], 'FULL'],
        ['not an array', 'x', 'FULL'],
        ['too many for HALF', [DARK_CHOCO, VANILLA], 'HALF'],
        ['too many for FULL', [DARK_CHOCO, VANILLA, CHEESE, 13], 'FULL'],
        ['inactive / unknown', [999], 'FULL'],
        ['duplicate', [VANILLA, VANILLA], 'FULL'],
        ['invalid id', [0], 'FULL'],
    ])('rejects %s', (_label, ids, boxType) => {
        expect(() => checkVariantSelection(ids, boxType as string, catalog)).toThrow(ValidationError);
    });
});

describe('isGramUnit', () => {
    it('accepts gram spellings only', () => {
        expect(['gram', 'Gram', ' g ', 'gr'].every(isGramUnit)).toBe(true);
        expect(['kg', 'pcs', '', null, undefined].some(isGramUnit)).toBe(false);
    });
});

describe('computeHpp', () => {
    const stocks = new Map([
        [1, { item_name: 'Tepung', price_per_unit: 140 }],
        [2, { item_name: 'Cokelat', price_per_unit: null }],
    ]);

    it('design-doc example: 50 g × Rp 140 = Rp 7.000 (FULL), Rp 3.500 (HALF)', () => {
        expect(computeHpp([{ stock_id: 1, qty_gram: 50 }], stocks).hpp).toBe(7000);
        expect(computeHpp([{ stock_id: 1, qty_gram: 25 }], stocks).hpp).toBe(3500);
    });

    it('reports stock items without a price and counts them as 0', () => {
        const result = computeHpp([{ stock_id: 1, qty_gram: 10 }, { stock_id: 2, qty_gram: 30 }], stocks);
        expect(result.hpp).toBe(1400);
        expect(result.missing_price).toEqual([2]);
        expect(result.breakdown[1]).toMatchObject({ item_name: 'Cokelat', subtotal: 0, price_per_unit: null });
    });

    it('empty usage → 0', () => {
        expect(computeHpp([], stocks)).toEqual({ hpp: 0, breakdown: [], missing_price: [] });
    });
});
