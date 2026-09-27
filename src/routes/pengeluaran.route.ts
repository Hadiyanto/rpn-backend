import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getPengeluaran, createPengeluaran } from '../services/pengeluaran.service';

const router = Router();

// GET /pengeluaran[?store_id=1 | ?store_id=general]
router.get('/pengeluaran', async (req, res) => {
    try {
        const raw = req.query.store_id;
        const store = raw === undefined || raw === '' ? undefined : raw === 'general' ? 'general' as const : Number(raw);
        res.json({ status: 'ok', data: await getPengeluaran(store) });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/pengeluaran', async (req, res) => {
    try {
        const { name, category, price, date, receipt_image_url, store_id } = req.body;

        if (!name || price === undefined || price === null) {
            res.status(400).json({ status: 'error', message: 'name dan price wajib diisi' });
            return;
        }

        const data = await createPengeluaran({ name, category, price: Number(price), date, receipt_image_url, store_id });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
