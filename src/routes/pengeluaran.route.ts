import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getPengeluaran, createPengeluaran, updatePengeluaran, deletePengeluaran } from '../services/pengeluaran.service';

const router = Router();

const idParam = (raw: string) => {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
};

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

// POST /pengeluaran { name, price, category?, date?, receipt_image_url?, store_id? } — validated in the service.
router.post('/pengeluaran', async (req, res) => {
    try {
        const { name, category, price, date, receipt_image_url, store_id } = req.body ?? {};
        const data = await createPengeluaran({ name, category, price, date, receipt_image_url, store_id });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /pengeluaran/:id — fix a wrongly entered expense (not the salary-booked ones).
router.put('/pengeluaran/:id', async (req, res) => {
    try {
        const id = idParam(req.params.id);
        if (!id) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const { name, category, price, date, receipt_image_url, store_id } = req.body ?? {};
        res.json({ status: 'ok', data: await updatePengeluaran(id, { name, category, price, date, receipt_image_url, store_id }) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// DELETE /pengeluaran/:id — remove a wrong or duplicate expense (not the salary-booked ones).
router.delete('/pengeluaran/:id', async (req, res) => {
    try {
        const id = idParam(req.params.id);
        if (!id) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        await deletePengeluaran(id);
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
