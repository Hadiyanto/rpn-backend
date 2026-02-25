import webpush from 'web-push';
import { supabase } from '../config/supabase';

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
    const { data, error } = await supabase
        .from('push_subscriptions')
        .upsert({ endpoint, p256dh, auth }, { onConflict: 'endpoint' })
        .select()
        .single();

    if (error) throw error;
    return data;
};

export const deleteSubscription = async (endpoint: string) => {
    const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint);

    if (error) throw error;
};

export const sendPushToAll = async (payload: { title: string; body: string; url?: string }) => {
    const { data: subs, error } = await supabase
        .from('push_subscriptions')
        .select('*');

    if (error || !subs) return;

    const message = JSON.stringify(payload);
    const results = await Promise.allSettled(
        subs.map((sub: { endpoint: string; p256dh: string; auth: string }) =>
            webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                message,
            ).catch(async (err) => {
                if (err.statusCode === 410) {
                    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
                }
            })
        )
    );

    return results;
};
