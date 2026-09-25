import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import healthRouter from './health';
import apiRoutes from './routes';

import { getWhatsAppService } from './services/whatsapp.service';
import { sendError } from './utils/errors';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 🔥 WAJIB kalau deploy di Render / Railway / Heroku
app.set('trust proxy', 1);

// Endpoints that pages poll or fetch in parallel get a looser limit instead of none at all.
const isPollingEndpoint = (req: express.Request) => {
    const p = req.path;
    return (
        req.method === 'GET' && (p.includes('/api/orders') || p.includes('/api/order/'))
    ) ||
        p.includes('/api/whatsapp/qr') ||
        p.includes('/api/whatsapp/status') ||
        p.includes('/api/whatsapp/contacts') ||
        p.includes('/api/menu') ||
        p.includes('/api/variants') ||
        p.includes('/api/daily-quota') ||
        p.includes('/api/hourly-quota');
};

const limitMessage = { status: 'error', message: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' };

// Separate counters, so heavy polling never eats into the budget for normal requests (and vice versa).
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, skip: isPollingEndpoint, message: limitMessage, standardHeaders: true, legacyHeaders: false }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, skip: req => !isPollingEndpoint(req), message: limitMessage, standardHeaders: true, legacyHeaders: false }));

app.use(cors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3000')
        .split(',')
        .map(o => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
}));

app.use(express.json());

app.use('/', healthRouter);
app.use('/api', apiRoutes);

// Last-resort error handler: malformed JSON bodies → 400, anything else → generic 500 (logged).
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    if (err?.type === 'entity.parse.failed') {
        res.status(400).json({ status: 'error', message: 'Body JSON tidak valid' });
        return;
    }
    sendError(res, err, `${req.method} ${req.path}`);
});




app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);

    // Initialize WhatsApp service. WHATSAPP_DISABLED=true skips it — needed when running a second
    // instance (e.g. local Docker) against the production Redis: two sockets on the same WA session
    // kick each other off and can log out the production number.
    if (process.env.WHATSAPP_DISABLED === 'true') {
        console.log('[server]: WhatsApp disabled (WHATSAPP_DISABLED=true)');
        return;
    }
    const waService = getWhatsAppService();
    waService.initialize().catch(err => {
        console.error('WhatsApp initialization failed:', err);
    });
});

export default app;
