import { Router } from 'express';
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
        res.status(500).json({ status: 'error', message: e.message });
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/hourly-quota', async (req, res) => {
    try {
        const { time_str, qty, hampers_qty, is_active, store_id } = req.body;

        if (!time_str || qty === undefined || !store_id) {
            res.status(400).json({ status: 'error', message: 'time_str, qty, dan store_id wajib diisi' });
            return;
        }

        const data = await upsertHourlyQuota(time_str, parseInt(qty, 10), store_id, hampers_qty !== undefined ? parseInt(hampers_qty, 10) : 0, is_active);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/hourly-quota/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await deleteHourlyQuota(id);
        res.json({ status: 'ok', message: 'deleted' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
