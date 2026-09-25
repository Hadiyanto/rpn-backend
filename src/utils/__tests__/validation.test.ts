import { describe, expect, it } from 'vitest';
import {
    ValidationError,
    todayWIB,
    validateOrderItems,
    validatePhone,
    validatePickupDate,
    validatePickupTime,
} from '../validation';

describe('validateOrderItems', () => {
    const item = (overrides: Record<string, unknown> = {}) => ({ box_type: 'FULL', name: 'Dark Choco', qty: 1, ...overrides });

    it('accepts valid FULL and HALF items and trims names', () => {
        expect(validateOrderItems([item({ name: '  Dark Choco ' }), item({ box_type: 'HALF', qty: 3 })])).toEqual([
            { box_type: 'FULL', name: 'Dark Choco', qty: 1 },
            { box_type: 'HALF', name: 'Dark Choco', qty: 3 },
        ]);
    });

    it.each([-100, -1, 0, 1.5, 51, '2', NaN, null])('rejects qty %s', (qty) => {
        expect(() => validateOrderItems([item({ qty })])).toThrow(ValidationError);
    });

    it('rejects HAMPERS with a specific message', () => {
        expect(() => validateOrderItems([item({ box_type: 'HAMPERS' })])).toThrow('Hampers sudah tidak tersedia');
    });

    it('rejects unknown box types, empty names, empty and oversized lists', () => {
        expect(() => validateOrderItems([item({ box_type: 'MEGA' })])).toThrow(ValidationError);
        expect(() => validateOrderItems([item({ name: '   ' })])).toThrow(ValidationError);
        expect(() => validateOrderItems([])).toThrow(ValidationError);
        expect(() => validateOrderItems('nope')).toThrow(ValidationError);
        expect(() => validateOrderItems(Array.from({ length: 21 }, () => item()))).toThrow(ValidationError);
    });
});

describe('todayWIB / validatePickupDate', () => {
    it('uses Jakarta time, not UTC', () => {
        // 2026-03-01 18:30 UTC is already 2026-03-02 01:30 in WIB
        expect(todayWIB(new Date('2026-03-01T18:30:00Z'))).toBe('2026-03-02');
    });

    const now = new Date('2026-03-02T03:00:00Z'); // 10:00 WIB

    it('accepts today and future dates', () => {
        expect(validatePickupDate('2026-03-02', { now })).toBe('2026-03-02');
        expect(validatePickupDate('2026-12-31', { now })).toBe('2026-12-31');
    });

    it('rejects past dates unless allowPast', () => {
        expect(() => validatePickupDate('2026-03-01', { now })).toThrow(ValidationError);
        expect(validatePickupDate('2026-03-01', { now, allowPast: true })).toBe('2026-03-01');
    });

    it.each(['2026-02-30', '2026-13-01', '02-03-2026', '', 20260302, undefined])('rejects malformed date %s', (d) => {
        expect(() => validatePickupDate(d, { now, allowPast: true })).toThrow(ValidationError);
    });
});

describe('validatePickupTime', () => {
    it('accepts HH:mm, ranges and empty values', () => {
        expect(validatePickupTime('12:30')).toBe('12:30');
        expect(validatePickupTime('11:00 - 16:00')).toBe('11:00 - 16:00');
        expect(validatePickupTime(undefined)).toBeUndefined();
        expect(validatePickupTime('')).toBeUndefined();
    });

    it.each([':', '25:00', '12:60', '12', 'noon', 1200])('rejects %s', (t) => {
        expect(() => validatePickupTime(t)).toThrow(ValidationError);
    });
});

describe('validatePhone', () => {
    it('accepts local and international formats', () => {
        expect(validatePhone('0812-3456-7890')).toBe('0812-3456-7890');
        expect(validatePhone('+62 812 3456 7890')).toBe('+62 812 3456 7890');
    });

    it.each(['', '123', 'abc', '0'.repeat(20), undefined])('rejects %s', (p) => {
        expect(() => validatePhone(p)).toThrow(ValidationError);
    });
});
