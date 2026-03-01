import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import healthRouter from './health';
import apiRoutes from './routes';

import { getWhatsAppService } from './services/whatsapp.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 🔥 WAJIB kalau deploy di Render / Railway / Heroku
app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    skip: (req) => {
        // Skip rate limiting for endpoints that require frequent polling or parallel fetching
        const p = req.path;
        return p.includes('/api/whatsapp/qr') ||
            p.includes('/api/whatsapp/status') ||
            p.includes('/api/whatsapp/contacts') ||
            p.includes('/api/menu') ||
            p.includes('/api/variants') ||
            p.includes('/api/daily-quota') ||
            p.includes('/api/hourly-quota');
    }
});

app.use(limiter);

app.use(cors({
    origin: ["http://localhost:3000", "http://192.168.18.52:3000", "https://rpn-frontend-omega.vercel.app"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
}));

app.use(express.json());

app.use('/', healthRouter);
app.use('/api', apiRoutes);




app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);

    // Initialize WhatsApp service
    const waService = getWhatsAppService();
    waService.initialize().catch(err => {
        console.error('WhatsApp initialization failed:', err);
    });
});

export default app;
