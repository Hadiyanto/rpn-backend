import { Router } from 'express';
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
