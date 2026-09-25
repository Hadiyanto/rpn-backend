import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getHourlyQuotas, upsertHourlyQuota, deleteHourlyQuota, getHourlyAvailability } from '../services/hourlyQuota.service';

const router = Router();

router.get('/hourly-quota', async (req, res) => {
    try {
        const store_id = Number(req.query.store_id);
        if (!store_id) {
            return res.status(400).json({ status: 'error', message: 'store_id is required' });
        }
        const data = await getHourlyQuotas(store_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.get('/hourly-quota/availability', async (req, res) => {
    try {
        const date = req.query.date as string;
        const store_id = Number(req.query.store_id);
        if (!date || !store_id) {
            res.status(400).json({ status: 'error', message: 'Parameter date dan store_id dibutuhkan' });
            return;
        }
        const data = await getHourlyAvailability(date, store_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/hourly-quota', async (req, res) => {
    try {
        const { time_str, qty, is_active, store_id } = req.body;

        if (!time_str || qty === undefined || !store_id) {
            res.status(400).json({ status: 'error', message: 'time_str, qty, dan store_id wajib diisi' });
            return;
        }

        const data = await upsertHourlyQuota(time_str, parseInt(qty, 10), store_id, is_active);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.delete('/hourly-quota/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await deleteHourlyQuota(id);
        res.json({ status: 'ok', message: 'deleted' });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
