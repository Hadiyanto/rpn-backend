import {
    AuthenticationCreds,
    AuthenticationState,
    initAuthCreds,
    SignalDataTypeMap,
    proto,
    BufferJSON
} from "@whiskeysockets/baileys";
import { redis } from "../config/redis";

export const useRedisAuthState = async (sessionName: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
}> => {

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
        const keys = await redis.keys(`${sessionName}:*`);
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

                set: async (data) => {
                    for (const category in data) {
                        const dict = (data as any)[category];
                        if (!dict) continue;

                        const hashKey = `${sessionName}:${category}`;

                        for (const id in dict) {
                            const value = dict[id];

                            if (value) {
                                await redis.hset(
                                    hashKey,
                                    {
                                        [id]: JSON.stringify(
                                            value,
                                            (key, val) => BufferJSON.replacer(key, val)
                                        )
                                    }
                                );
                            } else {
                                await redis.hdel(hashKey, id);
                            }
                        }
                    }
                }
            }
        },

        saveCreds: async () => {
            await writeData(credsKey, creds);
        },

        clearState
    };
};
