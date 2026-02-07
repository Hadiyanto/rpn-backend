import { Router } from 'express';

import menuRoute from './menu.route';
import variantRoute from './variant.route';
import stockRoute from './stock.route';
import transactionRoute from './transaction.route';
import penjualanRoute from './penjualan.route';
import pengeluaranRoute from './pengeluaran.route';

const router = Router();

router.use(menuRoute);
router.use(variantRoute);
router.use(stockRoute);
router.use(transactionRoute);
router.use(penjualanRoute);
router.use(pengeluaranRoute);

export default router;
