import { Router } from 'express';
import { getWhatsAppService } from '../services/whatsapp.service';

const router = Router();

/**
 * GET /whatsapp/qr
 * Get QR code for WhatsApp connection
 */
router.get('/whatsapp/qr', async (req, res) => {
    try {
        const waService = getWhatsAppService();
        const qrData = await waService.getQRCode();
        res.json(qrData);
    } catch (error: any) {
        console.error('Get QR error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * POST /whatsapp/regenerate
 * Regenerate QR code (logout and start new session)
 */
router.post('/whatsapp/regenerate', async (req, res) => {
    try {
        const waService = getWhatsAppService();
        const result = await waService.regenerateQR();
        res.json(result);
    } catch (error: any) {
        console.error('Regenerate QR error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /whatsapp/status
 * Get WhatsApp connection status
 */
router.get('/whatsapp/status', async (req, res) => {
    try {
        const waService = getWhatsAppService();
        const status = waService.getConnectionStatus();
        res.json(status);
    } catch (error: any) {
        console.error('Get status error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /whatsapp/contacts
 * Get list of contacts with phone numbers for sending messages
 */
router.get('/whatsapp/contacts', async (req, res) => {
    try {
        // We do not have a robust user/phone schema yet in RPN.
        // Returning an empty array. Manual phone input should be used.
        res.json({
            contacts: [],
            total: 0,
        });
    } catch (error: any) {
        console.error('Get contacts error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * POST /whatsapp/send
 * Send WhatsApp message
 */
router.post('/whatsapp/send', async (req, res) => {
    try {
        const { recipient, phone, phones, message } = req.body;

        if (!message) {
            return res.status(400).json({ message: 'Message is required' });
        }

        const waService = getWhatsAppService();

        if (!waService.isConnected) {
            return res.status(400).json({ message: 'WhatsApp not connected. Please scan QR code first.' });
        }

        let result;

        if (recipient === 'individual') {
            if (!phone) {
                return res.status(400).json({ message: 'Phone number is required for individual message' });
            }
            result = await waService.sendMessage(phone, message);
        } else if (recipient === 'group') {
            if (!phones || !Array.isArray(phones) || phones.length === 0) {
                return res.status(400).json({ message: 'Phone numbers array is required for group message' });
            }
            result = await waService.sendBroadcast(phones, message);
        } else if (recipient === 'all') {
            // Since we have no phone numbers mapping yet, we cannot broadcast to all.
            result = [];
        } else {
            return res.status(400).json({ message: 'Invalid recipient type' });
        }

        res.json({
            success: true,
            result,
        });
    } catch (error: any) {
        console.error('Send message error:', error);
        res.status(500).json({ message: error.message });
    }
});

export default router;
