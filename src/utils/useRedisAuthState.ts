import { proto, AuthenticationCreds, AuthenticationState, initAuthCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { redis } from '../config/redis';

/**
 * Returns a Baileys AuthenticationState backed by Upstash Redis.
 *
 * @param sessionName Name of the session to scope Redis keys.
 */
export const useRedisAuthState = async (sessionName: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void>, clearState: () => Promise<void> }> => {
    const credsKey = `${sessionName}:creds`;

    // We will use Baileys BufferJSON stringifier/parser instead of custom implementation
    const { BufferJSON } = require('@whiskeysockets/baileys');

    // Function to read data from Redis
    const readData = async (key: string) => {
        try {
            const data = await redis.get(key);
            if (data) {
                // If the Upstash response is already an object, use JSON.stringify then BufferJSON.parse.
                // If it is a string, just BufferJSON.parse.
                const strData = typeof data === 'string' ? data : JSON.stringify(data);
                return JSON.parse(strData, BufferJSON.reviver);
            }
        } catch (error) {
            console.error(`Error reading ${key} from Redis:`, error);
        }
        return null;
    };

    // Function to write data to Redis
    const writeData = async (key: string, data: any) => {
        try {
            const strData = JSON.stringify(data, BufferJSON.replacer);
            await redis.set(key, strData);
        } catch (error) {
            console.error(`Error writing ${key} to Redis:`, error);
        }
    };

    // Function to delete data from Redis
    const removeData = async (key: string) => {
        try {
            await redis.del(key);
        } catch (error) {
            console.error(`Error deleting ${key} from Redis:`, error);
        }
    };

    // Function to clear entire session
    const clearState = async () => {
        try {
            let cursor = '0';
            const allKeys: string[] = [];

            // Due to Upstash Redis REST constraints on 'keys' prefix scanning
            do {
                const [nextCursor, keysChunk] = await redis.scan(cursor, { match: `${sessionName}:*`, count: 100 });
                cursor = nextCursor;
                if (keysChunk.length > 0) {
                    allKeys.push(...keysChunk);
                }
            } while (cursor !== '0');

            if (allKeys.length > 0) {
                await redis.del(...allKeys);
            }
        } catch (error) {
            console.error(`Error clearing session ${sessionName} from Redis:`, error);
        }
    }

    let creds: AuthenticationCreds = await readData(credsKey) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
                    if (!ids || ids.length === 0) return data;

                    const hashKey = `${sessionName}:${type}`;
                    // We must use MGET since hmget will return an object for objects from Upstash unless configured differently
                    const results = await redis.hmget<Record<string, any>>(hashKey, ...ids);

                    if (!results) return data;

                    ids.forEach((id, index) => {
                        let value = results[index];
                        if (value) {
                            // Upstash might return a parsed object if it recognized JSON, or a string.
                            // To be perfectly safe, stringify first if object, then decode with BufferJSON.reviver.
                            const strValue = typeof value === 'string' ? value : JSON.stringify(value);

                            let parsed = JSON.parse(strValue, BufferJSON.reviver);

                            data[id] =
                                type === 'app-state-sync-key' && parsed
                                    ? proto.Message.AppStateSyncKeyData.fromObject(parsed as any)
                                    : parsed;
                        }
                    });

                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<any>[] = [];

                    for (const category of Object.keys(data)) {
                        const dict = data[category];
                        if (!dict) continue;

                        const hashKey = `${sessionName}:${category}`;

                        for (const id of Object.keys(dict)) {
                            const value = dict[id];

                            if (value) {
                                const serialized = JSON.stringify(value, BufferJSON.replacer);
                                tasks.push(redis.hset(hashKey, { [id]: serialized }));
                            } else {
                                tasks.push(redis.hdel(hashKey, id));
                            }
                        }
                    }

                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(credsKey, creds);
        },
        clearState
    };
};
