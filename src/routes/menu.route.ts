import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getMenus, createMenu, updateMenu, deleteMenu } from '../services/menu.service';
import { redis } from '../config/redis';
import { redisKeys } from '../utils/redisKeys';

const router = Router();

// Bump the version whenever the menu row shape changes so stale cached lists are ignored.
export const MENU_CACHE_KEY = redisKeys.menuCache;

const pickMenuFields = (body: any) => {
    const { name, price, description, is_active, store_ids, box_multiplier, max_flavors, weight_gram, length_cm, width_cm, height_cm } = body ?? {};
    return { name, price, description, is_active, store_ids, box_multiplier, max_flavors, weight_gram, length_cm, width_cm, height_cm };
};

router.get('/menu', async (req, res) => {
    try {
        const cacheKey = MENU_CACHE_KEY;
        let data: any = await redis.get(cacheKey);

        if (!data) {
            data = await getMenus();
            await redis.set(cacheKey, data, { ex: 2592000 }); // 1 month
        }

        const store_id = req.query.store_id ? Number(req.query.store_id) : undefined;
        if (store_id) {
            data = (data as any[]).filter(m => (m.store_ids ?? []).includes(store_id));
        }

        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.post('/menu', async (req, res) => {
    try {
        const data = await createMenu(pickMenuFields(req.body));
        await redis.del(MENU_CACHE_KEY);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.put('/menu/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = await updateMenu(id, pickMenuFields(req.body));
        await redis.del(MENU_CACHE_KEY);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

router.delete('/menu/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await deleteMenu(id);
        await redis.del(MENU_CACHE_KEY);
        res.json({ status: 'ok', message: 'Menu deleted' });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
