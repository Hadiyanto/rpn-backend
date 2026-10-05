import { Router } from 'express';
import { sendError } from '../utils/errors';
import { isDokuEnabled } from '../utils/doku';
import { handleDokuNotification, syncDokuPayment } from '../services/doku.service';
import { getPublicOrder } from '../services/order.service';
import { isBiteshipEnabled } from '../services/biteship.service';

const router = Router();

// Which payment methods the customer order form offers.
//   doku_enabled:     DOKU_PAYMENT=true → DOKU checkout (QRIS) replaces manual QRIS.
//   transfer_enabled: TRANSFER_PAYMENT=false hides bank transfer (on by default).
//   biteship_enabled: BITESHIP_ENABLED=true → the form may offer Store Delivery; whether it does for a
//                     customer depends on BITESHIP_WHITELIST (POST /api/biteship/eligibility).
router.get('/payment/config', (_req, res) => {
    res.json({
        status: 'ok',
        data: {
            doku_enabled: isDokuEnabled(),
            transfer_enabled: process.env.TRANSFER_PAYMENT !== 'false',
            biteship_enabled: isBiteshipEnabled(),
        },
    });
});

// DOKU HTTP notification. Set this URL in DOKU Back Office (or DOKU_NOTIFICATION_URL).
// The signature covers the path DOKU posted to, so we verify against our own request path.
router.post('/payments/doku/notification', async (req, res) => {
    try {
        const target = process.env.DOKU_NOTIFICATION_URL
            ? new URL(process.env.DOKU_NOTIFICATION_URL).pathname
            : req.originalUrl.split('?')[0];
        const outcome = await handleDokuNotification(req.headers, target, (req as { rawBody?: Buffer }).rawBody);
        res.json({ status: 'ok', data: { outcome } });
    } catch (e: any) {
        sendError(res, e, 'DOKU notification');
    }
});

// Customer is back from the DOKU checkout page: refresh the payment status, return the public order.
router.post('/order/public/:token/doku-sync', async (req, res) => {
    try {
        await syncDokuPayment(req.params.token);
        res.json({ status: 'ok', data: await getPublicOrder(req.params.token) });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
