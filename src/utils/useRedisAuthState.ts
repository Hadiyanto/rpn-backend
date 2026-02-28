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

    const readData = async (key: string) => {
        const data = await redis.get<string>(key);
        if (!data) return null;
        return JSON.parse(data, BufferJSON.reviver);
    };

    const writeData = async (key: string, value: any) => {
        await redis.set(key, JSON.stringify(value, BufferJSON.replacer));
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
                    if (!ids || ids.length === 0) return data;

                    const hashKey = `${sessionName}:${type}`;

                    // Upstash hmget typed to return a Record
                    const results = await redis.hmget<Record<string, string>>(hashKey, ...ids);

                    ids.forEach((id) => {
                        const value = results?.[id];
                        if (!value) return;

                        const parsed = JSON.parse(value, BufferJSON.reviver);

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
                                    { [id]: JSON.stringify(value, BufferJSON.replacer) }
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
