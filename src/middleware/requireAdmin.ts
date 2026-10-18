import type { NextFunction, Request, Response } from 'express';
import { canAccess } from './auth';

/**
 * Admin-only actions (store close/reopen, Biteship retries): superadmin/owner or the config page.
 * Needs loadSession (routes/index.ts); unlike `authorize` this is enforced in every AUTH_MODE,
 * as these routes were already locked before the own login existed.
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        res.status(401).json({ status: 'error', message: 'Login diperlukan' });
        return;
    }
    if (!canAccess(req.user, ['config'])) {
        res.status(403).json({ status: 'error', message: 'Akses admin diperlukan' });
        return;
    }
    next();
};
