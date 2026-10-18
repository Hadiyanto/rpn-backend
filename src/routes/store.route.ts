import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getStores, getStoreById, reopenStoreForOrders, updateStore } from '../services/store.service';
import { closeStore, unpaidCancelMessage } from '../services/storeClosure.service';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

// POST /stores/:id/close-orders { cancel_unpaid_ids?: number[] }
//   409 STORE_HAS_OPEN_ORDERS   → PAID/CONFIRMED orders must be DONE/CANCELLED first (admins get a push)
//   409 STORE_HAS_UNPAID_ORDERS → ask the admin, then send these ids back as cancel_unpaid_ids
//   200 → closed; data.cancelled = UNPAID orders now CANCELLED, data.not_cancelled = changed meanwhile
router.post('/stores/:id/close-orders', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        const rawIds = req.body?.cancel_unpaid_ids;
        if (rawIds !== undefined && (!Array.isArray(rawIds) || !rawIds.every((n: unknown) => Number.isInteger(n) && (n as number) > 0))) {
            res.status(400).json({ status: 'error', message: 'cancel_unpaid_ids harus berupa daftar id order' });
            return;
        }
        const result = await closeStore(id, rawIds);
        if (result.outcome === 'blocked') {
            res.status(409).json({
                status: 'error',
                code: 'STORE_HAS_OPEN_ORDERS',
                message: 'Toko belum bisa ditutup. Selesaikan atau batalkan semua order PAID/CONFIRMED terlebih dahulu.',
                data: { store: result.store, blockers: result.blockers, unpaid: result.unpaid },
            });
            return;
        }
        if (result.outcome === 'confirm_unpaid') {
            res.status(409).json({
                status: 'error',
                code: 'STORE_HAS_UNPAID_ORDERS',
                message: unpaidCancelMessage(result.unpaid),
                data: { store: result.store, unpaid: result.unpaid },
            });
            return;
        }
        res.json({ status: 'ok', data: { store: result.store, cancelled: result.cancelled, not_cancelled: result.notCancelled } });
    } catch (e: any) { sendError(res, e); }
});

router.post('/stores/:id/reopen-orders', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) {
            res.status(400).json({ status: 'error', message: 'id tidak valid' });
            return;
        }
        res.json({ status: 'ok', data: await reopenStoreForOrders(id) });
    } catch (e: any) { sendError(res, e); }
});

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
        const { name, address, area_id, latitude, longitude, phone, is_active, open_time, last_pickup_time, bank_name, bank_account_number, bank_account_name, qris_image_url, maps_url, labor_target_boxes, labor_reference_store_id } = req.body;
        const data = await updateStore(id, { name, address, area_id, latitude, longitude, phone, is_active, open_time, last_pickup_time, bank_name, bank_account_number, bank_account_name, qris_image_url, maps_url, labor_target_boxes, labor_reference_store_id });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
