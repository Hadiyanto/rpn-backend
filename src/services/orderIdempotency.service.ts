import { redis } from '../utils/redis';
import { redisKeys } from '../utils/redisKeys';
import { ConflictError } from '../utils/errors';
import { getOrderById } from './order.service';

// POST /order with an Idempotency-Key header (review 2026-10-19, I8): the order form sends one key per
// order it is trying to place, so a retry after a dropped connection gets the order that was already
// created instead of a second one.

const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const IN_PROGRESS = 0;
const TTL_SECONDS = 24 * 60 * 60;
/** How long a crashed attempt can block its key. */
const IN_PROGRESS_TTL_SECONDS = 10 * 60;

/** The response of an order created earlier for the same key (its DOKU link only while still payable). */
const replay = async (orderId: number) => {
    const order = await getOrderById(orderId);
    const payable = order.payment_method === 'DOKU' && order.status === 'UNPAID' && order.doku_payment_url;
    return payable ? { ...order, payment_url: order.doku_payment_url } : order;
};

/**
 * Runs `create` once per key. Without a (valid) key it simply runs. While the first request is still
 * running a repeat gets 409; a failed attempt frees the key so the customer can try again.
 */
export const createOrderOnce = async <T extends { id: number }>(key: string | undefined, create: () => Promise<T>) => {
    if (!key || !KEY_RE.test(key)) return { data: await create(), replayed: false };
    const redisKey = redisKeys.orderIdempotency(key);
    if (await redis.set(redisKey, IN_PROGRESS, { nx: true, ex: IN_PROGRESS_TTL_SECONDS }) === null) {
        const existing = Number(await redis.get(redisKey));
        if (!existing) throw new ConflictError('Pesanan ini sedang diproses. Tunggu sebentar lalu cek WhatsApp Anda.');
        return { data: await replay(existing), replayed: true };
    }
    try {
        const data = await create();
        await redis.set(redisKey, data.id, { ex: TTL_SECONDS });
        return { data, replayed: false };
    } catch (e) {
        await redis.del(redisKey).catch(() => undefined);
        throw e;
    }
};
