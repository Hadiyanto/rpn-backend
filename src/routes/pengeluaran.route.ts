import { Router } from 'express';
import { getPengeluaran, createPengeluaran } from '../services/pengeluaran.service';

const router = Router();

router.get('/pengeluaran', async (_req, res) => {
    try {
        const data = await getPengeluaran();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/pengeluaran', async (req, res) => {
    try {
        const { name, category, price, date, receipt_image_url } = req.body;

        if (!name || price === undefined || price === null) {
            res.status(400).json({ status: 'error', message: 'name dan price wajib diisi' });
            return;
        }

        const data = await createPengeluaran({ name, category, price: Number(price), date, receipt_image_url });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
