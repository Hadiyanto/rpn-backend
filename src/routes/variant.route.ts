import { Router } from 'express';
import { getVariants, createVariant, updateVariant, deleteVariant } from '../services/variant.service';
import { redis } from '../config/redis';

const router = Router();



router.get('/variants', async (req, res) => {
    try {
        const cacheKey = 'variant_list';
        const cachedData = await redis.get(cacheKey);

        if (cachedData) {
            return res.json({ status: 'ok', data: cachedData });
        }

        const data = await getVariants();
        await redis.set(cacheKey, data, { ex: 2592000 }); // 1 month

        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/variants', async (req, res) => {
    try {
        const { variant_name, is_active } = req.body;
        if (!variant_name) {
            return res.status(400).json({ status: 'error', message: 'variant_name is required' });
        }
        const data = await createVariant(variant_name, is_active);
        await redis.del('variant_list');
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/variants/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { variant_name, is_active } = req.body;
        const data = await updateVariant(id, { variant_name, is_active });
        await redis.del('variant_list');
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/variants/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await deleteVariant(id);
        await redis.del('variant_list');
        res.json({ status: 'ok', message: 'Variant deleted' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
