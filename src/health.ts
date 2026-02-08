import { Router } from 'express';
import { supabase } from './config/supabase';

const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('health')
            .select('status')
            .eq('id', 1)
            .single();

        if (error) {
            throw error;
        }

        res.json({
            response_code: 200,
            status: data?.status || 'unknown',
            time: new Date().toISOString()
        });
    } catch (err: any) {
        res.status(500).json({
            response_code: 500,
            status: 'error',
            message: err.message,
            time: new Date().toISOString()
        });
    }
});

export default healthRouter;
