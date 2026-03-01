import {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { useRedisAuthState } from '../utils/useRedisAuthState';

class WhatsAppService {
    public sock: any;
    public qr: string | null;
    public isConnected: boolean;
    private sessionName: string;
    private clearStateMethod: (() => Promise<void>) | null = null;
    private logger: any;
    private sendingQueue: Promise<any> = Promise.resolve();

    constructor() {
        this.sock = null;
        this.qr = null;
        this.isConnected = false;
        this.sessionName = 'rpn-wa-session';
        this.logger = pino({ level: 'silent' }); // Silent mode to reduce logs
    }

    private delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async initialize() {
        try {
            if (this.sock) {
                // Ensure the exact previous listeners are wiped to prevent memory leaks and zombie connections
                this.sock.ev.removeAllListeners();
                this.sock = null;
            }

            const { state, saveCreds, clearState } = await useRedisAuthState(this.sessionName);
            this.clearStateMethod = clearState;
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                logger: this.logger,
                auth: state,
                browser: ['RPN', 'Chrome', '1.0.0'],
            });

            // Connection updates
            this.sock.ev.on('connection.update', async (update: any) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qr = qr;
                    console.log('QR Code generated');
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as any)?.output?.payload?.statusCode || (lastDisconnect?.error as any)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log('Connection closed. Status:', statusCode);

                    this.isConnected = false;

                    if (shouldReconnect) {
                        // 440 = Conflict (e.g. another session active). Delay much longer to avoid rapid loop spam logs.
                        const isConflict = statusCode === 440 || statusCode === 409;
                        const delayTime = isConflict ? 15000 : 3000;
                        console.log(`Auto reconnecting in ${delayTime / 1000} seconds...`);
                        setTimeout(() => this.initialize(), delayTime);
                    } else {
                        console.log('Logged out. Clearing Redis session...');
                        if (this.clearStateMethod) {
                            await this.clearStateMethod();
                        }
                    }
                }

                if (connection === 'open') {
                    console.log('WhatsApp Connected!');
                    this.isConnected = true;
                    this.qr = null;
                }
            });

            // Save credentials
            this.sock.ev.on('creds.update', saveCreds);

        } catch (error) {
            console.error('WhatsApp initialization error:', error);
            throw error;
        }
    }

    async getQRCode() {
        if (this.isConnected) {
            return { connected: true, qr: null };
        }

        if (!this.qr) {
            return { connected: false, qr: null, message: 'QR not yet generated, please wait...' };
        }

        try {
            const qrDataURL = await QRCode.toDataURL(this.qr);
            return { connected: false, qr: qrDataURL };
        } catch (error: any) {
            console.error('QR generation error:', error);
            return { connected: false, qr: null, error: error.message };
        }
    }

    async regenerateQR() {
        try {
            if (this.sock && this.isConnected) {
                try {
                    await this.sock.logout();
                } catch (err) {
                    console.log("Logout skipped (already closed)");
                }
            }

            if (this.clearStateMethod) {
                await this.clearStateMethod();
            }

            this.isConnected = false;
            this.qr = null;

            await this.initialize();

            return { success: true, message: "QR regenerated" };

        } catch (error: any) {
            console.error("Regenerate QR error:", error);
            return { success: false, error: error.message };
        }
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.qr,
        };
    }

    async sendMessage(phone: string, message: string, isBroadcast: boolean = false) {
        if (!this.isConnected || !this.sock) {
            throw new Error('WhatsApp not connected');
        }

        const currentTask = this.sendingQueue.then(async () => {
            if (isBroadcast) {
                await this.delay(1500 + Math.random() * 2000); // 1.5 – 3.5 detik random throttle for broadcasts
            }

            // Format phone number (remove +, spaces, etc)
            const formattedPhone = phone.replace(/[^0-9]/g, '');
            const jid = formattedPhone.includes('@s.whatsapp.net')
                ? formattedPhone
                : `${formattedPhone}@s.whatsapp.net`;

            await this.sock.sendMessage(jid, { text: message });
            return { success: true, message: 'Message sent' };
        }).catch((error) => {
            console.error('Send message error:', error);
            throw error;
        });

        // Ensure the queue recovers if a message fails
        this.sendingQueue = currentTask.catch(() => { });

        return currentTask;
    }

    async sendBroadcast(phones: string[], message: string) {
        if (!this.isConnected) {
            throw new Error('WhatsApp not connected');
        }

        const results = [];
        for (const phone of phones) {
            try {
                await this.sendMessage(phone, message, true);
                results.push({ phone, success: true });
            } catch (error: any) {
                results.push({ phone, success: false, error: error.message });
            }
        }

        return results;
    }

    async getContacts() {
        if (!this.isConnected) {
            return [];
        }

        try {
            return [];
        } catch (error) {
            console.error('Get contacts error:', error);
            return [];
        }
    }
}

// Singleton instance
let waService: WhatsAppService | null = null;

export const getWhatsAppService = () => {
    if (!waService) {
        waService = new WhatsAppService();
    }
    return waService;
};
