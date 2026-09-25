import { Router } from 'express';
import { sendError } from '../utils/errors';
import { saveSubscription, deleteSubscription } from '../services/push.service';

const router = Router();

// POST /api/push/subscribe — simpan subscription dari browser
router.post('/push/subscribe', async (req, res) => {
    try {
        const { endpoint, keys } = req.body;
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            res.status(400).json({ status: 'error', message: 'Subscription tidak valid' });
            return;
        }
        const data = await saveSubscription({ endpoint, keys });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// DELETE /api/push/unsubscribe — hapus subscription
router.delete('/push/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) {
            res.status(400).json({ status: 'error', message: 'endpoint wajib diisi' });
            return;
        }
        await deleteSubscription(endpoint);
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e);
    }
});

// GET /api/push/vapid-public-key — serve public key ke frontend
router.get('/push/vapid-public-key', (_req, res) => {
    res.json({ status: 'ok', key: process.env.VAPID_PUBLIC_KEY });
});

export default router;
