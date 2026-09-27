import { describe, expect, it } from 'vitest';
import { computeSalary, validateTiers, type SalaryTier } from '../salary.service';
import { ValidationError } from '../../utils/validation';

const tiers: SalaryTier[] = [
    { min_box: 0, max_box: 15, amount: 150000, is_fixed: true },
    { min_box: 16, max_box: 20, amount: 5000, is_fixed: false },
    { min_box: 21, max_box: 25, amount: 6000, is_fixed: false },
    { min_box: 26, max_box: 30, amount: 7000, is_fixed: false },
];

describe('computeSalary', () => {
    it('matches the agreed examples: 15 → 150k, 20 → 175k, 25 → 205k, 30 → 240k, 35 → 240k', () => {
        expect([0, 10, 15, 16, 20, 25, 30, 35].map(n => computeSalary(tiers, n).total))
            .toEqual([150000, 150000, 150000, 155000, 175000, 205000, 240000, 240000]);
    });

    it('breakdown per tier (25 boxes)', () => {
        expect(computeSalary(tiers, 25).lines).toEqual([
            { from: 1, to: 15, boxes: 15, rate: 150000, fixed: true, amount: 150000 },
            { from: 16, to: 20, boxes: 5, rate: 5000, fixed: false, amount: 25000 },
            { from: 21, to: 25, boxes: 5, rate: 6000, fixed: false, amount: 30000 },
        ]);
    });

    it('no tiers → no salary', () => {
        expect(computeSalary([], 20)).toEqual({ total: 0, lines: [] });
    });
});

describe('validateTiers', () => {
    it('accepts contiguous tiers in any order', () => {
        expect(validateTiers([...tiers].reverse()).map(t => t.min_box)).toEqual([0, 16, 21, 26]);
    });

    it('rejects gaps, overlaps (e.g. 0–15 then 15–20), open-ended middle tiers and a second fixed tier', () => {
        const overlap = [tiers[0], { ...tiers[1], min_box: 15 }];
        const gap = [tiers[0], { ...tiers[1], min_box: 17 }];
        const openMiddle = [{ ...tiers[0], max_box: null }, tiers[1]];
        const twoFixed = [tiers[0], { ...tiers[1], is_fixed: true }];
        for (const bad of [overlap, gap, openMiddle, twoFixed]) {
            expect(() => validateTiers(bad)).toThrow(ValidationError);
        }
        expect(() => validateTiers([{ min_box: 5, max_box: 2, amount: 1, is_fixed: false }])).toThrow(ValidationError);
    });
});
