import { describe, expect, it } from 'vitest';
import { boxUnits, remainingQuota } from '../boxUnits';

describe('boxUnits', () => {
    it('counts FULL as 1 and HALF as 0.5', () => {
        expect(boxUnits([{ box_type: 'FULL', qty: 2 }, { box_type: 'HALF', qty: 3 }])).toBe(3.5);
    });

    it('ignores retired box types on historical orders', () => {
        expect(boxUnits([{ box_type: 'HAMPERS', qty: 4 }, { box_type: 'HALF', qty: 1 }])).toBe(0.5);
    });

    it('is 0 for no items', () => {
        expect(boxUnits([])).toBe(0);
    });
});

describe('remainingQuota', () => {
    it('subtracts used from qty', () => {
        expect(remainingQuota(50, 12.5)).toBe(37.5);
    });

    it('never goes negative when qty was lowered below what is sold', () => {
        expect(remainingQuota(10, 12)).toBe(0);
    });
});
