import type { NextFunction, Request, Response } from 'express';
import type { Page } from '../config/auth';
import { canAccess } from './auth';

/**
 * Login + one of `pages` (superadmin/owner always pass), enforced in every AUTH_MODE — unlike
 * `authorize`, which only logs in AUTH_MODE=log. Needs loadSession (routes/index.ts).
 */
export const requirePage = (...pages: Page[]) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        res.status(401).json({ status: 'error', message: 'Login diperlukan' });
        return;
    }
    if (!canAccess(req.user, pages)) {
        res.status(403).json({ status: 'error', message: pages.includes('config') ? 'Akses admin diperlukan' : 'Anda tidak punya akses ke halaman ini' });
        return;
    }
    next();
};

/**
 * Admin-only actions (store close/reopen): superadmin/owner or the config page. These routes were
 * already locked before the own login existed.
 */
export const requireAdmin = requirePage('config');
