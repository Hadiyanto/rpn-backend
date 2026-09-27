import { Router } from 'express';
import { sendError } from '../utils/errors';
import {
    getSalaryConfig, updateSalaryConfig, copySalaryConfig, getDailySalaries, generateDailySalary, calculateSalaryPreview,
} from '../services/salary.service';

const router = Router();

// GET /salary-config?store_id=1
router.get('/salary-config', async (req, res) => {
    try {
        res.json({ status: 'ok', data: await getSalaryConfig(Number(req.query.store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /salary-config  { store_id, tiers: [{ min_box, max_box, amount, is_fixed }] }
router.put('/salary-config', async (req, res) => {
    try {
        const { store_id, tiers } = req.body ?? {};
        res.json({ status: 'ok', data: await updateSalaryConfig(Number(store_id), tiers) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// POST /salary-config/copy  { from_store_id, to_store_id }
router.post('/salary-config/copy', async (req, res) => {
    try {
        const { from_store_id, to_store_id } = req.body ?? {};
        res.json({ status: 'ok', data: await copySalaryConfig(Number(from_store_id), Number(to_store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// GET /daily-salary[?store_id=1]
router.get('/daily-salary', async (req, res) => {
    try {
        const storeId = req.query.store_id ? Number(req.query.store_id) : undefined;
        res.json({ status: 'ok', data: await getDailySalaries(storeId) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// POST /daily-salary/preview  { date, store_id }
router.post('/daily-salary/preview', async (req, res) => {
    try {
        const { date, store_id } = req.body ?? {};
        if (!date) return res.status(400).json({ status: 'error', message: 'Tanggal wajib diisi (YYYY-MM-DD)' });
        res.json({ status: 'ok', data: await calculateSalaryPreview(date, Number(store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// POST /daily-salary/generate  { date, store_id } → also books the salary as the store's expense
router.post('/daily-salary/generate', async (req, res) => {
    try {
        const { date, store_id } = req.body ?? {};
        if (!date) return res.status(400).json({ status: 'error', message: 'Tanggal wajib diisi (YYYY-MM-DD)' });
        res.json({ status: 'ok', data: await generateDailySalary(date, Number(store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
