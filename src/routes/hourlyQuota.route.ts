import { Router } from 'express';
import { getHourlyQuotas, upsertHourlyQuota, deleteHourlyQuota, getHourlyAvailability } from '../services/hourlyQuota.service';

const router = Router();

router.get('/hourly-quota', async (req, res) => {
    try {
        const data = await getHourlyQuotas();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.get('/hourly-quota/availability', async (req, res) => {
    try {
        const date = req.query.date as string;
        if (!date) {
            res.status(400).json({ status: 'error', message: 'Parameter date dibutuhkan' });
            return;
        }
        const data = await getHourlyAvailability(date);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/hourly-quota', async (req, res) => {
    try {
        const { time_str, qty, hampers_qty, is_active } = req.body;

        if (!time_str || qty === undefined) {
            res.status(400).json({ status: 'error', message: 'time_str dan qty wajib diisi' });
            return;
        }

        const data = await upsertHourlyQuota(time_str, parseInt(qty, 10), hampers_qty !== undefined ? parseInt(hampers_qty, 10) : 0, is_active);
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
