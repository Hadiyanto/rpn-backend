import { describe, expect, it, vi } from 'vitest';

// In-memory Redis with just what the migration uses: scan (glob), renamenx, del.
const store = new Map<string, unknown>();
const globToRegex = (glob: string) => new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
vi.mock('../../config/redis', () => ({
    redis: {
        scan: async (_cursor: number, { match }: { match: string }) => [0, [...store.keys()].filter(k => globToRegex(match).test(k))],
        renamenx: async (from: string, to: string) => {
            if (store.has(to)) return 0;
            store.set(to, store.get(from));
            store.delete(from);
            return 1;
        },
        del: async (...keys: string[]) => keys.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    },
}));

describe('WhatsApp session key migration (rpn-wa-session:* → rpn:wa:main:*)', () => {
    it('moves every legacy key, leaves other apps alone, and is safe to run twice', async () => {
        const { migrateLegacySession } = await import('../useRedisAuthState');
        store.clear();
        store.set('rpn-wa-session:creds', 'C');
        store.set('rpn-wa-session:pre-key', 'P');
        store.set('resident:A2:3', 'other app');

        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await migrateLegacySession('rpn-wa-session', 'rpn:wa:main');
        expect(Object.fromEntries(store)).toEqual({
            'rpn:wa:main:creds': 'C',
            'rpn:wa:main:pre-key': 'P',
            'resident:A2:3': 'other app',
        });

        // A stale legacy key reappearing (old instance still running during a deploy) never overwrites the new one.
        store.set('rpn-wa-session:creds', 'STALE');
        await migrateLegacySession('rpn-wa-session', 'rpn:wa:main');
        expect(store.get('rpn:wa:main:creds')).toBe('C');
        expect(store.has('rpn-wa-session:creds')).toBe(false);
        log.mockRestore();
    });
});
