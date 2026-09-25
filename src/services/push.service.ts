import webpush from 'web-push';
import { pool } from '../config/db';

webpush.setVapidDetails(
    process.env.VAPID_EMAIL!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
);

export interface PushSubscriptionPayload {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}

export const saveSubscription = async (sub: PushSubscriptionPayload) => {
    const { endpoint, keys: { p256dh, auth } } = sub;

    // Upsert: update jika endpoint sudah ada
    const { rows } = await pool.query(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth)
        VALUES ($1, $2, $3)
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
        RETURNING *
    `, [endpoint, p256dh, auth]);
    return rows[0];
};

export const deleteSubscription = async (endpoint: string) => {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
};

export const sendPushToAll = async (payload: { title: string; body: string; url?: string }) => {
    let subs: { endpoint: string; p256dh: string; auth: string }[];
    try {
        subs = (await pool.query('SELECT * FROM push_subscriptions')).rows;
    } catch (err) {
        console.error('[push] could not load subscriptions', err);
        return;
    }

    const message = JSON.stringify(payload);
    const results = await Promise.allSettled(
        subs.map((sub: { endpoint: string; p256dh: string; auth: string }) =>
            webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                message,
            ).catch(async (err) => {
                if (err.statusCode === 410) {
                    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
                }
            })
        )
    );

    return results;
};
