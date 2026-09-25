import { Router } from 'express';
import { pool } from './config/db';

const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
    try {
        const { rows: [data] } = await pool.query('SELECT status FROM health WHERE id = 1');

        res.json({
            response_code: 200,
            status: data?.status || 'unknown',
            time: new Date().toISOString()
        });
    } catch (err: any) {
        console.error('[health]', err);
        res.status(500).json({
            response_code: 500,
            status: 'error',
            message: 'database unavailable',
            time: new Date().toISOString()
        });
    }
});

export default healthRouter;
