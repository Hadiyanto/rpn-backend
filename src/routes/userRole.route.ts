import { Router } from 'express';
import { sendError } from '../utils/errors';
import { getUserRoleOrDefault } from '../services/userRole.service';

const router = Router();

router.get('/user-role/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            res.status(400).json({ status: 'error', message: 'userId is required' });
            return;
        }
        const data = await getUserRoleOrDefault(userId);
        res.json({ status: 'ok', data });
    } catch (e: any) {
        sendError(res, e);
    }
});

export default router;
