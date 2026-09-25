import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getStocks, createStock, updateStock, deleteStock, adjustStock, getStockHistory } from '../services/stock.service';

const router = Router();

router.get('/stocks', async (req, res) => {
    try {
        const store_id = req.query.store_id ? Number(req.query.store_id) : undefined;
        const data = await getStocks(store_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/stocks', async (req, res) => {
    try {
        const { item_name, unit, store_id, qty } = req.body;
        const data = await createStock({ item_name, unit, store_id, qty });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.put('/stocks/:id', async (req, res) => {
    try {
        const { item_name, unit } = req.body;
        const data = await updateStock(Number(req.params.id), { item_name, unit });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.delete('/stocks/:id', async (req, res) => {
    try {
        await deleteStock(Number(req.params.id));
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/stocks/adjust', async (req, res) => {
    try {
        const data = await adjustStock(req.body);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.get('/stocks/:id/history', async (req, res) => {
    try {
        const stockId = parseInt(req.params.id);
        const data = await getStockHistory(stockId);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
