import { Router } from 'express';
import { getStocks } from '../services/stock.service';

const router = Router();

router.get('/stocks', async (_req, res) => {
    try {
        const data = await getStocks();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
