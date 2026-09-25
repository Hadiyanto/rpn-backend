import { Router } from 'express';
import { sendError } from '../utils/errors';
import {
    getVariantRecipes,
    replaceVariantRecipe,
    deleteVariantRecipeLine,
    getVariantComponents,
    replaceVariantComponents,
    getVariantHpp,
} from '../services/variantRecipe.service';
import { redis } from '../config/redis';
import { VARIANT_CACHE_KEY } from './variant.route';

const router = Router();

// GET /variant-recipe?store_id=1[&variant_id=5]
router.get('/variant-recipe', async (req, res) => {
    try {
        const store_id = Number(req.query.store_id);
        if (!store_id) {
            res.status(400).json({ status: 'error', message: 'store_id wajib diisi' });
            return;
        }
        const variant_id = req.query.variant_id ? Number(req.query.variant_id) : undefined;
        const data = await getVariantRecipes({ store_id, variant_id });
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /variant-recipe  { variant_id, store_id, items: [{ stock_id, qty_gram }] }
router.put('/variant-recipe', async (req, res) => {
    try {
        const { variant_id, store_id, items } = req.body;
        const data = await replaceVariantRecipe(Number(variant_id), Number(store_id), items);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.delete('/variant-recipe/:id', async (req, res) => {
    try {
        await deleteVariantRecipeLine(Number(req.params.id));
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e);
    }
});

// GET /variant-hpp?variant_ids=1,2&box_type=FULL&store_id=1
router.get('/variant-hpp', async (req, res) => {
    try {
        const variantIds = String(req.query.variant_ids ?? '')
            .split(',')
            .map(s => Number(s.trim()))
            .filter(n => Number.isInteger(n) && n > 0);
        const boxType = String(req.query.box_type ?? 'FULL').toUpperCase();
        const storeId = Number(req.query.store_id);
        if (variantIds.length === 0 || !storeId || !['FULL', 'HALF'].includes(boxType)) {
            res.status(400).json({ status: 'error', message: 'variant_ids, box_type (FULL/HALF), dan store_id wajib diisi' });
            return;
        }
        const data = await getVariantHpp(variantIds, boxType, storeId);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// GET /variant-components[?variant_id=18]
router.get('/variant-components', async (req, res) => {
    try {
        const variant_id = req.query.variant_id ? Number(req.query.variant_id) : undefined;
        const data = await getVariantComponents(variant_id);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /variant-components  { variant_id, component_ids: number[] }
router.put('/variant-components', async (req, res) => {
    try {
        const { variant_id, component_ids } = req.body;
        const data = await replaceVariantComponents(Number(variant_id), component_ids);
        await redis.del(VARIANT_CACHE_KEY); // variant list embeds component_ids
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
