import {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

class WhatsAppService {
    public sock: any;
    public qr: string | null;
    public isConnected: boolean;
    private authPath: string;
    private logger: any;

    constructor() {
        this.sock = null;
        this.qr = null;
        this.isConnected = false;
        this.authPath = path.join(process.cwd(), 'whatsapp-session');
        this.logger = pino({ level: 'silent' }); // Silent mode to reduce logs
    }

    async initialize() {
        try {
            // Ensure auth directory exists
            if (!fs.existsSync(this.authPath)) {
                fs.mkdirSync(this.authPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
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
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log('Connection closed, reconnecting:', shouldReconnect);

                    this.isConnected = false;
                    this.qr = null;

                    if (shouldReconnect) {
                        console.log('Connection closed. User must regenerate manually from Dashboard.');
                    } else {
                        // Logged out
                        if (fs.existsSync(this.authPath)) {
                            try {
                                fs.rmSync(this.authPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
                            } catch (err) {
                                console.error('Failed to remove session folder:', err);
                            }
                        }
                    }
                } else if (connection === 'open') {
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
            // Logout current session
            if (this.sock) {
                await this.sock.logout();
            }

            // Delete session files
            if (fs.existsSync(this.authPath)) {
                try {
                    fs.rmSync(this.authPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
                } catch (err) {
                    console.error('Failed to remove session folder during regenerate:', err);
                }
            }

            // Reinitialize
            this.isConnected = false;
            this.qr = null;
            await this.initialize();

            return { success: true, message: 'QR regenerated, please scan' };
        } catch (error: any) {
            console.error('Regenerate QR error:', error);
            return { success: false, error: error.message };
        }
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.qr,
        };
    }

    async sendMessage(phone: string, message: string) {
        if (!this.isConnected || !this.sock) {
            throw new Error('WhatsApp not connected');
        }

        try {
            // Format phone number (remove +, spaces, etc)
            const formattedPhone = phone.replace(/[^0-9]/g, '');
            const jid = formattedPhone.includes('@s.whatsapp.net')
                ? formattedPhone
                : `${formattedPhone}@s.whatsapp.net`;

            await this.sock.sendMessage(jid, { text: message });
            return { success: true, message: 'Message sent' };
        } catch (error) {
            console.error('Send message error:', error);
            throw error;
        }
    }

    async sendBroadcast(phones: string[], message: string) {
        if (!this.isConnected) {
            throw new Error('WhatsApp not connected');
        }

        const results = [];
        for (const phone of phones) {
            try {
                await this.sendMessage(phone, message);
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
