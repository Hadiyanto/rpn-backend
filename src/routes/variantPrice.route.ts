import { Router } from 'express';
import { sendError } from '../utils/errors';
import { redis } from '../config/redis';
import { VARIANT_CACHE_KEY } from './variant.route';
import { getVariantPrices, setVariantPrice } from '../services/variantPrice.service';

const router = Router();

// GET /variant-price?store_id=1
router.get('/variant-price', async (req, res) => {
    try {
        res.json({ status: 'ok', data: await getVariantPrices(Number(req.query.store_id)) });
    } catch (e: any) {
        sendError(res, e);
    }
});

// PUT /variant-price  { variant_id, store_id, price_full, price_half }  (null/'' = empty)
router.put('/variant-price', async (req, res) => {
    try {
        const { variant_id, store_id, price_full, price_half } = req.body ?? {};
        const data = await setVariantPrice(Number(variant_id), Number(store_id), { price_full, price_half });
        await redis.del(VARIANT_CACHE_KEY); // prices / availability are part of the variant list
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
