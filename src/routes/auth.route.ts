import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { SESSION_COOKIE, SESSION_TTL_MS, sessionCookieOptions } from '../config/auth';
import { changePassword, login, logout, toProfile } from '../services/auth.service';
import { sendError } from '../utils/errors';

const router = Router();

// 5 tries per 15 minutes per IP + email. Keyed on the email too: behind Cloudflare many
// customers can share one IP, and a typo-ing admin shouldn't lock the others out.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: req => `${ipKeyGenerator(req.ip ?? '')}|${String(req.body?.email ?? '').trim().toLowerCase()}`,
    skipSuccessfulRequests: true,
    message: { status: 'error', message: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// POST /auth/login { email, password } → session cookie + profile
router.post('/auth/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body ?? {};
        const { token, user } = await login(email, password, { userAgent: req.header('user-agent'), ip: req.ip });
        res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: SESSION_TTL_MS });
        res.json({ status: 'ok', data: toProfile(user) });
    } catch (e: any) {
        sendError(res, e, 'POST /auth/login');
    }
});

// POST /auth/logout → ends this session (idempotent)
router.post('/auth/logout', async (req, res) => {
    try {
        if (req.sessionToken) await logout(req.sessionToken);
        res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e, 'POST /auth/logout');
    }
});

// 5 wrong current passwords per 15 minutes per user, so a stolen session can't guess the password.
const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: req => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    skipSuccessfulRequests: true,
    message: { status: 'error', message: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// POST /auth/change-password { current_password, new_password } → own password; other sessions signed out
router.post('/auth/change-password', changePasswordLimiter, async (req, res) => {
    if (!req.user || !req.sessionToken) {
        res.status(401).json({ status: 'error', message: 'Login diperlukan' });
        return;
    }
    try {
        const { current_password, new_password } = req.body ?? {};
        await changePassword(req.user.id, req.sessionToken, current_password, new_password);
        res.json({ status: 'ok' });
    } catch (e: any) {
        sendError(res, e, 'POST /auth/change-password');
    }
});

// GET /auth/me → profile of the logged-in user, 401 without a session
router.get('/auth/me', (req, res) => {
    if (!req.user) {
        res.status(401).json({ status: 'error', message: 'Login diperlukan' });
        return;
    }
    res.json({ status: 'ok', data: toProfile(req.user) });
});

export default router;
