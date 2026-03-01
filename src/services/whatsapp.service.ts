import {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { useRedisAuthState } from '../utils/useRedisAuthState';

class WhatsAppService {
    public sock: any = null;
    public qr: string | null = null;
    public isConnected = false;

    private sessionName = 'rpn-wa-session';
    private clearStateMethod: (() => Promise<void>) | null = null;
    private logger = pino({ level: 'silent' });

    private sendingQueue: Promise<any> = Promise.resolve();
    private initializing = false;

    private delay(ms: number) {
        return new Promise(res => setTimeout(res, ms));
    }

    async initialize() {
        if (this.initializing) return;
        this.initializing = true;

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

            const { state, saveCreds, clearState } = await useRedisAuthState(this.sessionName);
            this.clearStateMethod = clearState;

            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                logger: this.logger,
                auth: state,
                browser: ['RPN', 'Chrome', '1.0.0']
            });

            // 🔔 CONNECTION HANDLER
            this.sock.ev.on('connection.update', async (update: any) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qr = qr;
                    console.log('QR Code generated');
                }

                if (connection === 'open') {
                    console.log('WhatsApp Connected!');
                    this.isConnected = true;
                    this.qr = null;
                }

                if (connection === 'close') {
                    const statusCode =
                        (lastDisconnect?.error as any)?.output?.payload?.statusCode ||
                        (lastDisconnect?.error as any)?.output?.statusCode;

                    console.log('Connection closed. Status:', statusCode);
                    this.isConnected = false;

                    // ❌ DO NOT AUTO RECONNECT FOR 440 / 409
                    if (statusCode === 440 || statusCode === 409) {
                        console.log('Connection replaced. Waiting manual action.');
                        return;
                    }

                    // 🔓 LOGGED OUT → CLEAR SESSION
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log('Logged out. Clearing Redis session...');
                        if (this.clearStateMethod) {
                            await this.clearStateMethod();
                        }
                        return;
                    }

                    // 🔁 NORMAL RECONNECT
                    console.log('Reconnecting in 5 seconds...');
                    setTimeout(() => this.initialize(), 5000);
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

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.qr
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
            await this.sock.sendMessage(jid, { text: message });

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
