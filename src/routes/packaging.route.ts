import { Router } from 'express';
import { sendError } from '../utils/errors';
import { copyPackagingRules, getPackagingRules, replacePackagingRules } from '../services/packaging.service';

const router = Router();

// GET /packaging-rule?store_id=1 → packaging items used per order at that store
router.get('/packaging-rule', async (req, res) => {
    try {
        res.json({ status: 'ok', data: await getPackagingRules(Number(req.query.store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /packaging-rule  { store_id, items: [{ stock_id, box_type, mode, qty, boxes_per_unit }] }
router.put('/packaging-rule', async (req, res) => {
    try {
        const { store_id, items } = req.body ?? {};
        res.json({ status: 'ok', data: await replacePackagingRules(Number(store_id), items) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// POST /packaging-rule/copy  { from_store_id, to_store_id }
router.post('/packaging-rule/copy', async (req, res) => {
    try {
        const { from_store_id, to_store_id } = req.body ?? {};
        res.json({ status: 'ok', data: await copyPackagingRules(Number(from_store_id), Number(to_store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
