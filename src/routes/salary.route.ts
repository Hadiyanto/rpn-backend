import { Router } from 'express';
import { getSalaryConfig, updateSalaryConfig, getDailySalaries, generateDailySalary } from '../services/salary.service';

const router = Router();

router.get('/salary-config', async (_req, res) => {
    try {
        const data = await getSalaryConfig();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/salary-config', async (req, res) => {
    try {
        const data = await updateSalaryConfig(req.body);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.get('/daily-salary', async (_req, res) => {
    try {
        const data = await getDailySalaries();
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/daily-salary/generate', async (req, res) => {
    try {
        const { date } = req.body;
        if (!date) {
            return res.status(400).json({ status: 'error', message: 'Date is required (YYYY-MM-DD)' });
        }
        const data = await generateDailySalary(date);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
