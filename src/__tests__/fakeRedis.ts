// Minimal in-memory stand-in for the Upstash client methods used by quota code.
export const createFakeRedis = () => {
    const store = new Map<string, number>();
    return {
        store,
        exists: async (key: string) => (store.has(key) ? 1 : 0),
        get: async (key: string) => (store.has(key) ? store.get(key)! : null),
        mget: async (...keys: string[]) => keys.map(k => (store.has(k) ? store.get(k)! : null)),
        set: async (key: string, value: number | string, opts?: { nx?: boolean }) => {
            if (opts?.nx && store.has(key)) return null;
            store.set(key, Number(value));
            return 'OK';
        },
        incrbyfloat: async (key: string, delta: number) => {
            const next = (store.get(key) ?? 0) + delta;
            store.set(key, next);
            return next;
        },
        del: async (...keys: string[]) => keys.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    };
};
