import { Router } from 'express';
import { getMenus, createMenu, updateMenu, deleteMenu } from '../services/menu.service';
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
        const { name, price, description, is_active } = req.body;
        const data = await updateMenu(id, { name, price, description, is_active });
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
