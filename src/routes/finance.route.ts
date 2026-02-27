import { Router } from 'express';
import { getWeeklySummary } from '../services/finance.service';

const router = Router();

router.get('/finance/summary', async (req, res) => {
    try {
        const { start, end } = req.query as { start: string; end: string };

        if (!start || !end) {
            return res.status(400).json({ status: 'error', message: 'start & end required' });
        }

        const data = await getWeeklySummary(start, end);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

export default router;
