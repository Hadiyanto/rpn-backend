import { describe, expect, it } from 'vitest';
import { dayOfWeek, formatDateID, todayWIB } from '../date';

describe('todayWIB', () => {
    it('is already tomorrow between 17:00 and 24:00 UTC', () => {
        expect(todayWIB(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-02');
        expect(todayWIB(new Date('2026-03-01T16:59:00Z'))).toBe('2026-03-01');
    });
});

describe('dayOfWeek', () => {
    it('uses the calendar date, not the server timezone', () => {
        expect(dayOfWeek('2026-03-02')).toBe(1); // Monday
        expect(dayOfWeek('2026-03-01')).toBe(0); // Sunday
    });
});

describe('formatDateID', () => {
    it('formats a calendar date in Indonesian without shifting the day', () => {
        expect(formatDateID('2026-03-02')).toBe('Senin, 2 Maret 2026');
    });
});
