import { Router } from 'express';
import { sendError } from '../utils/errors';
import {
    getDailyQuotas,
    getDailyQuotaByDate,
    createDailyQuota,
    updateDailyQuota,
    deleteDailyQuota,
} from '../services/dailyQuota.service';

const router = Router();

router.get('/daily-quota', async (req, res) => {
    try {
        const store_id = Number(req.query.store_id);
        if (!store_id) {
            return res.status(400).json({ status: 'error', message: 'store_id is required' });
        }
        const date = req.query.date as string;
        if (date) {
            const data = await getDailyQuotaByDate(date, store_id);
            return res.json({ status: 'ok', data });
        }
        const data = await getDailyQuotas(store_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e, 'daily-quota GET');
    }
});

router.post('/daily-quota', async (req, res) => {
    try {
        const { date, qty, store_id } = req.body;
        if (!date || qty === undefined || !store_id) {
            return res.status(400).json({ status: 'error', message: 'date, qty, and store_id are required' });
        }
        const data = await createDailyQuota(date, qty, store_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        if (e.code === '23505') { // Unique constraint violation
            res.status(400).json({ status: 'error', message: 'Quota for this date already exists' });
        } else {
            sendError(res, e);
        }
    }
});

router.put('/daily-quota/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { qty } = req.body;
        if (qty === undefined) {
            return res.status(400).json({ status: 'error', message: 'qty is required' });
        }
        const data = await updateDailyQuota(id, qty);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.delete('/daily-quota/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await deleteDailyQuota(id);
        res.json({ status: 'ok', message: 'Daily quota deleted' });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
