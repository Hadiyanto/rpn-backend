import { Router } from 'express';
import { getTransactions } from '../services/transaction.service';

const router = Router();

router.get('/transactions', async (_req, res) => {
    try {
        const data = await getTransactions();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
