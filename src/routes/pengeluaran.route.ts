import { Router } from 'express';
import { getPengeluaran } from '../services/pengeluaran.service';

const router = Router();

router.get('/pengeluaran', async (_req, res) => {
    try {
        const data = await getPengeluaran();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
