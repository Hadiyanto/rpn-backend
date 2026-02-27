import { Router } from 'express';
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
        const date = req.query.date as string;
        if (date) {
            const data = await getDailyQuotaByDate(date);
            return res.json({ status: 'ok', data });
        }
        const data = await getDailyQuotas();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/daily-quota', async (req, res) => {
    try {
        const { date, qty } = req.body;
        if (!date || qty === undefined) {
            return res.status(400).json({ status: 'error', message: 'date and qty are required' });
        }
        const data = await createDailyQuota(date, qty);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        if (e.code === '23505') { // Unique constraint violation
            res.status(400).json({ status: 'error', message: 'Quota for this date already exists' });
        } else {
            res.status(500).json({ status: 'error', message: e.message });
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/daily-quota/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await deleteDailyQuota(id);
        res.json({ status: 'ok', message: 'Daily quota deleted' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
