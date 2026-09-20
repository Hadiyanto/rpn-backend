import { Router } from 'express';
import { getStores, getStoreById, updateStore } from '../services/store.service';

const router = Router();

router.get('/stores', async (req, res) => {
    try {
        const data = await getStores();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/stores/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const { name, address, area_id, latitude, longitude, phone, is_active, open_time } = req.body;
        const data = await updateStore(id, { name, address, area_id, latitude, longitude, phone, is_active, open_time });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(400).json({ status: 'error', message: e.message });
    }
});

export default router;
