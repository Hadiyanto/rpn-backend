import { describe, expect, it } from 'vitest';
import { hourOf, redisKeys, redisPatterns } from '../redisKeys';

describe('redisKeys', () => {
    it('namespaces every key under rpn:', () => {
        const all = [
            redisKeys.dailyQuota(1, '2026-10-01'),
            redisKeys.hourlyQuota(1, '2026-10-01', '12:00'),
            redisKeys.menuCache,
            redisKeys.variantsCache,
            redisKeys.waSession('main'),
            redisPatterns.quota,
            redisPatterns.cache,
        ];
        expect(all.every(k => k.startsWith('rpn:'))).toBe(true);
    });

    it('keys hourly slots by hour only, whatever the time format', () => {
        expect(redisKeys.hourlyQuota(2, '2026-10-01', '12:00')).toBe('rpn:quota:hourly:2:2026-10-01:12');
        expect(redisKeys.hourlyQuota(2, '2026-10-01', '09:30')).toBe('rpn:quota:hourly:2:2026-10-01:09');
        expect(hourOf('9')).toBe('09');
    });

    it('daily and hourly keys both match the quota cleanup pattern', () => {
        const toRegex = (glob: string) => new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        expect(toRegex(redisPatterns.quota).test(redisKeys.dailyQuota(1, '2026-10-01'))).toBe(true);
        expect(toRegex(redisPatterns.quota).test(redisKeys.hourlyQuota(1, '2026-10-01', '12:00'))).toBe(true);
        expect(toRegex(redisPatterns.quota).test('resident:A2:3')).toBe(false);
    });
});
