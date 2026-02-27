import { Router } from 'express';
import { getDebts, createDebt, updateDebt, deleteDebt } from '../services/debt.service';

const router = Router();

router.get('/debt', async (req, res) => {
    try {
        const data = await getDebts();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/debt', async (req, res) => {
    try {
        const { source, total_amount, remaining_amount, status } = req.body;
        if (!source || total_amount === undefined || remaining_amount === undefined) {
            return res.status(400).json({ status: 'error', message: 'source, total_amount, and remaining_amount are required' });
        }

        const data = await createDebt({ source, total_amount, remaining_amount, status });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/debt/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ status: 'error', message: 'invalid id' });
        }

        const { source, total_amount, remaining_amount, status } = req.body;
        const data = await updateDebt(id, { source, total_amount, remaining_amount, status });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/debt/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ status: 'error', message: 'invalid id' });
        }

        await deleteDebt(id);
        res.json({ status: 'ok', message: 'Deleted successfully' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
