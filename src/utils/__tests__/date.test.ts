import { describe, expect, it } from 'vitest';
import { dayOfWeek, formatDateID, nowTimeWIB, todayWIB } from '../date';

describe('todayWIB', () => {
    it('is already tomorrow between 17:00 and 24:00 UTC', () => {
        expect(todayWIB(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-02');
        expect(todayWIB(new Date('2026-03-01T16:59:00Z'))).toBe('2026-03-01');
    });
});

describe('nowTimeWIB', () => {
    it('is the WIB clock (UTC+7), 24 h, also past midnight', () => {
        expect(nowTimeWIB(new Date('2026-10-19T02:03:00Z'))).toBe('09:03');
        expect(nowTimeWIB(new Date('2026-10-19T16:59:00Z'))).toBe('23:59');
        expect(nowTimeWIB(new Date('2026-10-19T17:05:00Z'))).toBe('00:05');
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
