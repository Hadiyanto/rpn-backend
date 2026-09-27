import { describe, expect, it } from 'vitest';
import { computePackagingUsage, perBoxRules, type PackagingRule } from '../packaging.service';

// Stock ids: 1 = Box Besar, 2 = Box Kecil, 3 = Garpu, 4 = Plastik Kuning, 5 = Sticker
const rules: PackagingRule[] = [
    { stock_id: 1, box_type: 'FULL', mode: 'per_box', qty: 1, boxes_per_unit: null },
    { stock_id: 2, box_type: 'HALF', mode: 'per_box', qty: 1, boxes_per_unit: null },
    { stock_id: 3, box_type: null, mode: 'per_box', qty: 1, boxes_per_unit: null },
    { stock_id: 4, box_type: null, mode: 'per_boxes', qty: 1, boxes_per_unit: 2 },
    { stock_id: 5, box_type: null, mode: 'per_order', qty: 1, boxes_per_unit: null },
];
const qtyOf = (boxes: Record<string, number>, stockId: number) =>
    computePackagingUsage(rules, boxes).find(u => u.stock_id === stockId)?.qty_gram ?? 0;

describe('computePackagingUsage', () => {
    it('2 FULL + 1 HALF → Box Besar 2, Box Kecil 1, Garpu 3, Plastik 2, Sticker 1', () => {
        expect(computePackagingUsage(rules, { FULL: 2, HALF: 1 })).toEqual([
            { stock_id: 1, qty_gram: 2 },
            { stock_id: 2, qty_gram: 1 },
            { stock_id: 3, qty_gram: 3 },
            { stock_id: 4, qty_gram: 2 },
            { stock_id: 5, qty_gram: 1 },
        ]);
    });

    it('plastic bag covers 2 boxes of any type: 1–2 → 1, 3–4 → 2, 5 → 3', () => {
        expect([1, 2, 3, 4, 5].map(n => qtyOf({ FULL: n }, 4))).toEqual([1, 1, 2, 2, 3]);
        expect(qtyOf({ FULL: 1, HALF: 1 }, 4)).toBe(1);
        expect(qtyOf({ FULL: 1, HALF: 2 }, 4)).toBe(2);
    });

    it('sticker once per order, whatever the number of boxes', () => {
        expect(qtyOf({ FULL: 7, HALF: 3 }, 5)).toBe(1);
    });

    it('no boxes → nothing', () => {
        expect(computePackagingUsage(rules, {})).toEqual([]);
        expect(computePackagingUsage(rules, { FULL: 0 })).toEqual([]);
    });

    it('rules for a box type ignore other types; qty multiplies', () => {
        const forks: PackagingRule[] = [
            { stock_id: 3, box_type: 'FULL', mode: 'per_box', qty: 2, boxes_per_unit: null },
            { stock_id: 3, box_type: 'HALF', mode: 'per_box', qty: 1, boxes_per_unit: null },
        ];
        expect(computePackagingUsage(forks, { FULL: 2, HALF: 1 })).toEqual([{ stock_id: 3, qty_gram: 5 }]);
    });

    it('perBoxRules keeps only per-box rules for that box type (per-box HPP)', () => {
        expect(perBoxRules(rules, 'FULL').map(r => r.stock_id)).toEqual([1, 3]);
        expect(perBoxRules(rules, 'HALF').map(r => r.stock_id)).toEqual([2, 3]);
    });
});
