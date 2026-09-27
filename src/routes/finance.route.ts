import { Router } from 'express';
import { getWeeklySummary } from '../services/finance.service';

const router = Router();

router.get('/finance/summary', async (req, res) => {
    try {
        const { start, end, store_id } = req.query as { start: string; end: string; store_id?: string };

        if (!start || !end) {
            return res.status(400).json({ status: 'error', message: 'start & end required' });
        }

        const data = await getWeeklySummary(start, end, store_id ? Number(store_id) : undefined);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

export default router;
