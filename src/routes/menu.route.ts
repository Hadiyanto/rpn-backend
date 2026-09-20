import { Router } from 'express';
import { getMenus, createMenu, updateMenu, deleteMenu } from '../services/menu.service';
import { redis } from '../config/redis';

const router = Router();

router.get('/menu', async (req, res) => {
    try {
        const cacheKey = 'menu_list';
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.post('/menu', async (req, res) => {
    try {
        const { name, price, description, is_active } = req.body;
        if (!name || price === undefined) {
            return res.status(400).json({ status: 'error', message: 'name and price are required' });
        }
        const data = await createMenu(name, price, description, is_active);
        await redis.del('menu_list');
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.put('/menu/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, price, description, is_active, store_ids } = req.body;
        const data = await updateMenu(id, { name, price, description, is_active, store_ids });
        await redis.del('menu_list');
        res.json({ status: 'ok', data });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

router.delete('/menu/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await deleteMenu(id);
        await redis.del('menu_list');
        res.json({ status: 'ok', message: 'Menu deleted' });
    } catch (e: any) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
