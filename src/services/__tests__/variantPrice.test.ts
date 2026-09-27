import { describe, expect, it } from 'vitest';
import { computeBoxPrice, type FlavorPrice } from '../variantPrice.service';
import { ValidationError } from '../../utils/validation';

const prices = new Map<number, FlavorPrice>([
    [1, { variant_id: 1, variant_name: 'Choco', price_full: 60000, price_half: 32500 }],
    [2, { variant_id: 2, variant_name: 'Choco Oreo', price_full: 65000, price_half: 35000 }],
    [3, { variant_id: 3, variant_name: 'Choco Cheese', price_full: 68000, price_half: null }],
]);

describe('computeBoxPrice', () => {
    it('single flavor → its price for that box type', () => {
        expect(computeBoxPrice([1], 'FULL', prices)).toEqual({ unit_price: 60000, price_variant_id: 1 });
        expect(computeBoxPrice([2], 'HALF', prices)).toEqual({ unit_price: 35000, price_variant_id: 2 });
    });

    it('mix → the most expensive flavor (no rounding, no averaging)', () => {
        expect(computeBoxPrice([1, 3], 'FULL', prices)).toEqual({ unit_price: 68000, price_variant_id: 3 });
        expect(computeBoxPrice([1, 2], 'FULL', prices)).toEqual({ unit_price: 65000, price_variant_id: 2 });
        expect(computeBoxPrice([1, 2, 3], 'FULL', prices).unit_price).toBe(68000);
    });

    it('a flavor without a price for that box type (or at all) cannot be sold', () => {
        expect(() => computeBoxPrice([3], 'HALF', prices)).toThrow(/Choco Cheese belum ada harga Box Kecil/);
        expect(() => computeBoxPrice([1, 99], 'FULL', prices)).toThrow(ValidationError);
        expect(() => computeBoxPrice([], 'FULL', prices)).toThrow(ValidationError);
    });
});
