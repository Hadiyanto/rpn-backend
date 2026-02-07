import { Router } from 'express';
import { getPenjualanByTransaction } from '../services/penjualan.service';

const router = Router();

router.get('/penjualan/:transactionId', async (req, res) => {
    try {
        const id = Number(req.params.transactionId);
        const data = await getPenjualanByTransaction(id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
