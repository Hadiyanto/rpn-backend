import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getTransactions, createTransaction } from '../services/transaction.service';

const router = Router();

router.get('/transactions', async (_req, res) => {
    try {
        const data = await getTransactions();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/transaction', async (req, res) => {
    try {
        const { items, total_price_checkout, customer_name } = req.body;
        const data = await createTransaction(items, total_price_checkout, customer_name);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
