import { describe, expect, it } from 'vitest';
import { weightedAverageCost } from '../stockCost';

describe('weightedAverageCost', () => {
    it('averages what is on hand with the new purchase', () => {
        // 2000 g @ 140 + 5000 g @ 160 → 154.2857
        expect(weightedAverageCost(2000, 140, 5000, 160)).toBe(154.2857);
    });

    it('uses the purchase price when nothing is on hand, stock is negative, or there is no cost yet', () => {
        expect(weightedAverageCost(0, 140, 5000, 160)).toBe(160);
        expect(weightedAverageCost(-300, 140, 5000, 160)).toBe(160);
        expect(weightedAverageCost(2000, null, 5000, 160)).toBe(160);
    });

    it('keeps the current cost when nothing actually comes in', () => {
        expect(weightedAverageCost(2000, 140, 0, 999)).toBe(140);
    });
});
