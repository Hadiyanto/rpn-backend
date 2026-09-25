import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getSetupStatus } from '../services/setup.service';

const router = Router();

// GET /setup-status?store_id=1
router.get('/setup-status', async (req, res) => {
    try {
        const storeId = Number(req.query.store_id);
        if (!storeId) {
            res.status(400).json({ status: 'error', message: 'store_id wajib diisi' });
            return;
        }
        const data = await getSetupStatus(storeId);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
