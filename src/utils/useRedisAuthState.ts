import {
    AuthenticationCreds,
    AuthenticationState,
    initAuthCreds,
    SignalDataTypeMap,
    proto,
    BufferJSON
} from "@whiskeysockets/baileys";
import { redis } from "../config/redis";

/** All keys matching `pattern`, via SCAN (never KEYS: the Redis instance is shared with other apps). */
const scanKeys = async (pattern: string): Promise<string[]> => {
    const found: string[] = [];
    let cursor: string | number = 0;
    do {
        const [next, keys]: [string | number, string[]] = await redis.scan(cursor, { match: pattern, count: 500 });
        cursor = next;
        found.push(...keys);
    } while (String(cursor) !== '0');
    return found;
};

/**
 * One-time move of a session stored under an old prefix to the new one. RENAMENX is atomic and
 * never overwrites a key that already exists under the new name, so running it again is harmless.
 */
export const migrateLegacySession = async (legacyPrefix: string, sessionName: string) => {
    const legacyKeys = await scanKeys(`${legacyPrefix}:*`);
    for (const key of legacyKeys) {
        const target = `${sessionName}${key.slice(legacyPrefix.length)}`;
        const moved = await redis.renamenx(key, target);
        if (!moved) await redis.del(key); // already migrated: the new key wins
    }
    if (legacyKeys.length > 0) console.log(`[wa] migrated ${legacyKeys.length} session key(s) from ${legacyPrefix}:* to ${sessionName}:*`);
};

export const useRedisAuthState = async (sessionName: string, legacyPrefix?: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
}> => {
    if (legacyPrefix && legacyPrefix !== sessionName) await migrateLegacySession(legacyPrefix, sessionName);

    const credsKey = `${sessionName}:creds`;

    // -------- SAFE READ (handle string OR object) --------
    const readData = async (key: string) => {
        const data = await redis.get(key);
        if (!data) return null;

        if (typeof data === "string") {
            return JSON.parse(data, BufferJSON.reviver);
        }

        // Upstash may auto-parse JSON
        return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
    };

    // -------- SAFE WRITE --------
    const writeData = async (key: string, value: any) => {
        await redis.set(
            key,
            JSON.stringify(
                value,
                (key, val) => BufferJSON.replacer(key, val)
            )
        );
    };

    const clearState = async () => {
        const keys = await scanKeys(`${sessionName}:*`);
        if (keys.length) {
            await redis.del(...keys);
        }
    };

    const creds: AuthenticationCreds =
        (await readData(credsKey)) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
                    if (!ids?.length) return data;

                    const hashKey = `${sessionName}:${type}`;

                    const raw = await redis.hmget(hashKey, ...ids);

                    let results: any[] = [];

                    // Upstash can return array OR object
                    if (Array.isArray(raw)) {
                        results = raw;
                    } else if (raw && typeof raw === "object") {
                        results = ids.map(id => raw[id] ?? null);
                    }

                    ids.forEach((id, index) => {
                        const value = results[index];
                        if (!value) return;

                        let parsed;

                        if (typeof value === "string") {
                            parsed = JSON.parse(value, BufferJSON.reviver);
                        } else {
                            parsed = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
                        }

                        data[id] =
                            type === "app-state-sync-key"
                                ? proto.Message.AppStateSyncKeyData.fromObject(parsed)
                                : parsed;
                    });

                    return data;
                },

                // Batched writes: history/app-state sync hands over thousands of keys at once, and
                // one REST call per key (Upstash) made queries time out. Chunked so a single
                // request stays well under Upstash's request size limit.
                set: async (data) => {
                    const CHUNK = 200;
                    let pipeline = redis.pipeline();
                    let pending = 0;
                    const flush = async () => {
                        if (pending === 0) return;
                        await pipeline.exec();
                        pipeline = redis.pipeline();
                        pending = 0;
                    };
                    for (const category in data) {
                        const dict = (data as any)[category];
                        if (!dict) continue;

                        const hashKey = `${sessionName}:${category}`;
                        let toSet: Record<string, string> = {};
                        const toDelete: string[] = [];
                        for (const id in dict) {
                            const value = dict[id];
                            if (!value) { toDelete.push(id); continue; }
                            toSet[id] = JSON.stringify(value, (key, val) => BufferJSON.replacer(key, val));
                            if (Object.keys(toSet).length >= CHUNK) {
                                pipeline.hset(hashKey, toSet); pending++;
                                toSet = {};
                                await flush();
                            }
                        }
                        if (Object.keys(toSet).length > 0) { pipeline.hset(hashKey, toSet); pending++; }
                        if (toDelete.length > 0) { pipeline.hdel(hashKey, ...toDelete); pending++; }
                        if (pending >= 20) await flush();
                    }
                    await flush();
                }
            }
        },

        saveCreds: async () => {
            await writeData(credsKey, creds);
        },

        clearState
    };
};
