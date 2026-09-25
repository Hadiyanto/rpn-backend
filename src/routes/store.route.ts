import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getStores, getStoreById, updateStore } from '../services/store.service';

const router = Router();

router.get('/stores', async (req, res) => {
    try {
        const data = await getStores();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.get('/stores/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const data = await getStoreById(id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.put('/stores/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const { name, address, area_id, latitude, longitude, phone, is_active, open_time, bank_name, bank_account_number, bank_account_name } = req.body;
        const data = await updateStore(id, { name, address, area_id, latitude, longitude, phone, is_active, open_time, bank_name, bank_account_number, bank_account_name });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
