import {
    makeWASocket,
    Browsers,
    BufferJSON,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    proto,
    type CacheStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { useRedisAuthState } from '../utils/useRedisAuthState';
import { LEGACY_WA_SESSION_PREFIX, redisKeys } from '../utils/redisKeys';
import { redis } from '../config/redis';

// How long a sent message can still be re-sent on request (phones ask within minutes, rarely later).
const SENT_MESSAGE_TTL = 3 * 24 * 60 * 60;

/** Minimal in-memory CacheStore (Baileys counts decrypt retries per message here). */
const memoryCache = (): CacheStore => {
    const map = new Map<string, unknown>();
    return {
        get: <T>(key: string) => map.get(key) as T | undefined,
        set: <T>(key: string, value: T) => { map.set(key, value); if (map.size > 5000) map.delete(map.keys().next().value as string); },
        del: (key: string) => { map.delete(key); },
        flushAll: () => map.clear(),
    };
};

/**
 * What the admin page shows:
 *  disabled   WHATSAPP_DISABLED=true on this server (another instance owns the session)
 *  starting   socket not up yet / reconnecting
 *  qr         waiting for the QR to be scanned
 *  connected  linked and ready to send
 *  replaced   the session was taken over by another device/server (440/409); needs a new QR
 */
export type WhatsAppState = 'disabled' | 'starting' | 'qr' | 'connected' | 'replaced';

export const isWhatsAppDisabled = () => process.env.WHATSAPP_DISABLED === 'true';

class WhatsAppService {
    public sock: any = null;
    public qr: string | null = null;
    public isConnected = false;
    private state: WhatsAppState = 'starting';

    // Auth keys live under rpn:wa:main:* (renamed from the pre-namespace rpn-wa-session:* on first start).
    private sessionName = redisKeys.waSession('main');
    private clearStateMethod: (() => Promise<void>) | null = null;
    private logger = pino({ level: 'silent' });

    private sendingQueue: Promise<any> = Promise.resolve();
    // Survives reconnects, so retry counting isn't reset every time the socket restarts.
    private msgRetryCounterCache = memoryCache();
    private initializing = false;

    private delay(ms: number) {
        return new Promise(res => setTimeout(res, ms));
    }

    async initialize() {
        if (isWhatsAppDisabled()) {
            this.state = 'disabled';
            return;
        }
        if (this.initializing) return;
        this.initializing = true;
        this.state = 'starting';

        try {
            // 🔥 HARD STOP old socket (prevent zombie connection)
            if (this.sock) {
                try {
                    this.sock.end?.();
                } catch { }
                try {
                    this.sock.ev.removeAllListeners();
                } catch { }
                this.sock = null;
            }

            const { state, saveCreds, clearState } = await useRedisAuthState(this.sessionName, LEGACY_WA_SESSION_PREFIX);
            this.clearStateMethod = clearState;

            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                logger: this.logger,
                // Signal keys (per-contact sessions) cached in memory in front of Redis: every
                // message advances the session, and the next message must be encrypted with the
                // latest one. Reading it back from Upstash (a round trip, possibly a lagging read
                // replica) could hand Baileys an older session → the recipient sees
                // "Menunggu pesan ini" from the second message on. Writes still go to Redis.
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
                // A standard browser identity: WhatsApp may refuse to link made-up ones
                // ("Can't link new devices right now").
                browser: Browsers.macOS('Desktop'),
                // The bot only sends notifications: skip downloading chat history after linking
                // (thousands of keys/messages to store) and don't show the number as "online".
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                markOnlineOnConnect: false,
                // When a recipient's phone can't decrypt a message ("Menunggu pesan ini"), it asks us
                // to send it again; Baileys re-encrypts what getMessage returns. Without it the
                // message stays unreadable.
                getMessage: async (key: proto.IMessageKey) => (key.id ? this.loadSentMessage(key.id) : undefined),
                msgRetryCounterCache: this.msgRetryCounterCache
            });

            // 🔔 CONNECTION HANDLER
            this.sock.ev.on('connection.update', async (update: any) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qr = qr;
                    this.state = 'qr';
                    console.log('QR Code generated');
                }

                if (connection === 'open') {
                    console.log('WhatsApp Connected!');
                    this.isConnected = true;
                    this.qr = null;
                    this.state = 'connected';
                }

                if (connection === 'close') {
                    const statusCode =
                        (lastDisconnect?.error as any)?.output?.payload?.statusCode ||
                        (lastDisconnect?.error as any)?.output?.statusCode;

                    // The reason text tells e.g. "Connection Closed" (428) from "Stream Errored" / "QR refs attempts ended".
                    console.log('Connection closed. Status:', statusCode, '-', (lastDisconnect?.error as any)?.message ?? 'no reason');
                    this.isConnected = false;
                    this.qr = null;

                    // ❌ DO NOT AUTO RECONNECT FOR 440 / 409: another device/server took the session;
                    // reconnecting would just fight it. The admin page offers "QR baru" instead.
                    if (statusCode === 440 || statusCode === 409) {
                        console.log('Connection replaced. Waiting manual action.');
                        this.state = 'replaced';
                        return;
                    }

                    // 🔓 LOGGED OUT (unlinked from the phone) → clear the session and start over,
                    // so a fresh QR shows up without pressing anything.
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log('Logged out. Clearing Redis session and generating a new QR...');
                        if (this.clearStateMethod) {
                            await this.clearStateMethod();
                        }
                        this.state = 'starting';
                        setTimeout(() => this.initialize(), 1000);
                        return;
                    }

                    // 🔁 NORMAL RECONNECT (515 right after scanning is expected: WhatsApp restarts the stream)
                    const wait = statusCode === DisconnectReason.restartRequired ? 500 : 5000;
                    this.state = 'starting';
                    console.log(`Reconnecting in ${wait / 1000} seconds...`);
                    setTimeout(() => this.initialize(), wait);
                }
            });

            // 💾 SAVE CREDS
            this.sock.ev.on('creds.update', saveCreds);

        } catch (err) {
            console.error('WhatsApp initialization error:', err);
        } finally {
            this.initializing = false;
        }
    }

    async getQRCode() {
        if (isWhatsAppDisabled()) {
            return { connected: false, qr: null, disabled: true, message: 'WhatsApp dinonaktifkan di server ini (WHATSAPP_DISABLED=true)' };
        }
        if (this.isConnected) {
            return { connected: true, qr: null };
        }

        if (!this.qr) {
            return { connected: false, qr: null, message: 'QR not ready yet' };
        }

        const qrDataURL = await QRCode.toDataURL(this.qr);
        return { connected: false, qr: qrDataURL };
    }

    async regenerateQR() {
        if (isWhatsAppDisabled()) {
            return { success: false, error: 'WhatsApp dinonaktifkan di server ini (WHATSAPP_DISABLED=true)' };
        }
        try {
            // 🔥 Do not logout if already closed
            if (this.sock && this.isConnected) {
                try {
                    await this.sock.logout();
                } catch {
                    console.log('Logout skipped (already closed)');
                }
            }

            if (this.clearStateMethod) {
                await this.clearStateMethod();
            }

            this.isConnected = false;
            this.qr = null;

            await this.initialize();

            return { success: true, message: 'QR regenerated' };
        } catch (error: any) {
            console.error('Regenerate QR error:', error);
            return { success: false, error: error.message };
        }
    }

    /** Keeps a sent message for a few days so a retry request from the recipient can be served. */
    private async storeSentMessage(sent: { key?: proto.IMessageKey; message?: proto.IMessage | null } | undefined) {
        if (!sent?.key?.id || !sent.message) return;
        try {
            await redis.set(
                redisKeys.waSentMessage(sent.key.id),
                JSON.stringify(proto.Message.toObject(proto.Message.fromObject(sent.message)), BufferJSON.replacer),
                { ex: SENT_MESSAGE_TTL },
            );
        } catch (err) {
            console.error('[wa] could not store sent message for retries', err);
        }
    }

    private async loadSentMessage(id: string): Promise<proto.IMessage | undefined> {
        try {
            const raw = await redis.get(redisKeys.waSentMessage(id));
            if (!raw) return undefined;
            const obj = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), BufferJSON.reviver);
            return proto.Message.fromObject(obj);
        } catch (err) {
            console.error('[wa] could not load sent message for retry', err);
            return undefined;
        }
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.qr,
            disabled: isWhatsAppDisabled(),
            state: isWhatsAppDisabled() ? 'disabled' as const : this.state,
        };
    }

    // 📨 SAFE SEND (QUEUE + THROTTLE)
    async sendMessage(phone: string, message: string, isBroadcast = false) {
        if (!this.isConnected || !this.sock) {
            throw new Error('WhatsApp not connected');
        }

        const task = this.sendingQueue.then(async () => {
            if (isBroadcast) {
                await this.delay(1500 + Math.random() * 2000);
            }

            const jid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            const sent = await this.sock.sendMessage(jid, { text: message });
            await this.storeSentMessage(sent);

            return { success: true };
        });

        // 🔄 Keep queue alive even if error happens
        this.sendingQueue = task.catch(() => { });

        return task;
    }

    async sendBroadcast(phones: string[], message: string) {
        const results = [];
        for (const phone of phones) {
            try {
                await this.sendMessage(phone, message, true);
                results.push({ phone, success: true });
            } catch (err: any) {
                results.push({ phone, success: false, error: err.message });
            }
        }
        return results;
    }
}

// 🔒 SINGLETON
let waService: WhatsAppService | null = null;

export const getWhatsAppService = () => {
    if (!waService) {
        waService = new WhatsAppService();
    }
    return waService;
};
