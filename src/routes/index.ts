import { Router } from 'express';

import menuRoute from './menu.route';
import variantRoute from './variant.route';
import stockRoute from './stock.route';
import transactionRoute from './transaction.route';
import penjualanRoute from './penjualan.route';
import pengeluaranRoute from './pengeluaran.route';
import orderRoute from './order.route';
import pushRoute from './push.route';
import userRoleRoute from './userRole.route';
import dailyQuotaRoute from './dailyQuota.route';
import capitalRoute from './capital.route';
import debtRoute from './debt.route';
import financeRoute from './finance.route';
import uploadRoute from './upload.route';

const router = Router();

router.use(menuRoute);
router.use(variantRoute);
router.use(stockRoute);
router.use(transactionRoute);
router.use(penjualanRoute);
router.use(pengeluaranRoute);
router.use(orderRoute);
router.use(pushRoute);
router.use(userRoleRoute);
router.use(dailyQuotaRoute);
router.use(capitalRoute);
router.use(debtRoute);
router.use(financeRoute);
router.use(uploadRoute);

export default router;

