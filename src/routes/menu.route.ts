import { Router } from 'express';
import { getMenus } from '../services/menu.service';
import { redis } from '../config/redis';

const router = Router();

router.get('/menu', async (_req, res) => {
    try {
        const cacheKey = 'menu_list';
        const cachedData = await redis.get(cacheKey);

        if (cachedData) {
            return res.json({ status: 'ok', data: cachedData });
        }

        const data = await getMenus();
        await redis.set(cacheKey, data, { ex: 2592000 }); // 1 month

        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
