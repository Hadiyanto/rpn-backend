import { Router } from 'express';
import { getTransactions, createTransaction } from '../services/transaction.service';

const router = Router();

router.get('/transactions', async (_req, res) => {
    try {
        const data = await getTransactions();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/transaction', async (req, res) => {
    try {
        const { items, total_price_checkout, customer_name } = req.body;
        const data = await createTransaction(items, total_price_checkout, customer_name);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
