import { Router } from 'express';
import { getVariants } from '../services/variant.service';
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

export default router;
