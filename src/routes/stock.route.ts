import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getStocks, createStock, updateStock, deleteStock, adjustStock, getStockHistory, getStockHistoryReport, updateStockMovement } from '../services/stock.service';

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
        const { item_name, unit, store_id, qty, price_per_unit, created_at } = req.body;
        const data = await createStock({ item_name, unit, store_id, qty, price_per_unit, created_at });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.put('/stocks/:id', async (req, res) => {
    try {
        const { item_name, unit, price_per_unit } = req.body;
        const data = await updateStock(Number(req.params.id), { item_name, unit, price_per_unit });
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

// Correct a manual movement (qty, total_price, notes, created_at); the item's history is replayed.
router.put('/stocks/history/:historyId', async (req, res) => {
    try {
        const historyId = Number(req.params.historyId);
        if (!Number.isInteger(historyId)) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const { qty, total_price, notes, created_at } = req.body ?? {};
        res.json({ status: 'ok', data: await updateStockMovement(historyId, { qty, total_price, notes, created_at }) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// GET /stocks/:id/history/report?from=YYYY-MM-DD&to=YYYY-MM-DD (WIB, inclusive)
// → movements in the period + ledger summary + Sales-style (pickup date) summary.
router.get('/stocks/:id/history/report', async (req, res) => {
    try {
        const data = await getStockHistoryReport(Number(req.params.id), String(req.query.from ?? ''), String(req.query.to ?? ''));
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
