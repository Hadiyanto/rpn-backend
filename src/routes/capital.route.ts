import { Router } from 'express';
import { getCapitals, createCapital, updateCapital, deleteCapital } from '../services/capital.service';

const router = Router();

router.get('/capital', async (req, res) => {
    try {
        const data = await getCapitals();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/capital', async (req, res) => {
    try {
        const { amount, note } = req.body;
        if (amount === undefined) {
            return res.status(400).json({ status: 'error', message: 'amount is required' });
        }

        const data = await createCapital({ amount, note });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/capital/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ status: 'error', message: 'invalid id' });
        }

        const { amount, note } = req.body;
        const data = await updateCapital(id, { amount, note });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/capital/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ status: 'error', message: 'invalid id' });
        }

        await deleteCapital(id);
        res.json({ status: 'ok', message: 'Deleted successfully' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
