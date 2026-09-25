import { describe, expect, it } from 'vitest';
import { aggregateDeductions } from '../stockDeduction.service';

describe('aggregateDeductions', () => {
    it('multiplies per-box usage by qty and sums per stock item', () => {
        const totals = aggregateDeductions([
            { qty: 2, usage: [{ stock_id: 1, qty_gram: 50 }, { stock_id: 2, qty_gram: 30 }] },
            { qty: 1, usage: [{ stock_id: 1, qty_gram: 25 }] },
        ]);
        expect(Object.fromEntries(totals)).toEqual({ 1: 125, 2: 60 });
    });

    it('rounds to 2 decimals (stock_history precision) and drops zeros', () => {
        const totals = aggregateDeductions([
            { qty: 1, usage: [{ stock_id: 1, qty_gram: 46.6667 }, { stock_id: 3, qty_gram: 0.001 }] },
        ]);
        expect(Object.fromEntries(totals)).toEqual({ 1: 46.67 });
    });

    it('no items → nothing to deduct', () => {
        expect(aggregateDeductions([]).size).toBe(0);
    });
});
