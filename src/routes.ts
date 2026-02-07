import { Router } from 'express';
import { supabase } from './config/supabase';

const router = Router();

router.get('/health', async (req, res) => {
    try {
        // Basic connectivity check: retrieve session
        const { data, error } = await supabase.auth.getSession();

        if (error) {
            throw error;
        }

        res.json({
            status: 'ok',
            service: 'rpn-backend',
            timestamp: new Date().toISOString(),
            supabase: 'connected'
        });
    } catch (err: any) {
        res.status(500).json({
            status: 'error',
            message: err.message,
            supabase: 'disconnected'
        });
    }
});

export default router;
