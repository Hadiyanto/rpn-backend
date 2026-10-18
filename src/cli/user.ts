/**
 * Admin users for the own login (docs/plan-lepas-vendor.md §4.4).
 *
 *   VPS:   docker exec -it rpn-backend node dist/cli/user.js <command> …
 *   local: npx ts-node src/cli/user.ts <command> …   (uses DATABASE_URL — mind .env = production)
 *
 *   list
 *   create <email> <superadmin|owner|employee> [page,page,…]   → prints a generated password
 *   reset-password <email>                                      → prints a generated password, signs out everywhere
 *   access <email> <role> [page,page,…]                         → change role / pages
 *   disable <email> | enable <email>
 *
 * Pages: orders, sales, analytics, stock, shipping, salary, finance, cashflow, summary, config
 * (superadmin and owner always see every page).
 */
import { pool } from '../config/db';
import { createUser, listUsers, resetPassword, setUserAccess, setUserActive } from '../services/auth.service';
import { generatePassword } from '../utils/password';

const USAGE = 'usage: user.js list | create <email> <role> [pages] | reset-password <email> | access <email> <role> [pages] | disable <email> | enable <email>';

const pagesArg = (arg?: string) => (arg ? arg.split(',').map(p => p.trim()).filter(Boolean) : undefined);

const dbHost = () => {
    try {
        const url = new URL(process.env.DATABASE_URL ?? '');
        return `${url.hostname}${url.pathname}`;
    } catch {
        return '(DATABASE_URL tidak valid)';
    }
};

const main = async () => {
    const [cmd, email, role, pages] = process.argv.slice(2);
    console.log(`database: ${dbHost()}`);
    switch (cmd) {
        case 'list':
            console.table(await listUsers());
            return;
        case 'create': {
            if (!email || !role) throw new Error(USAGE);
            const password = generatePassword();
            const user = await createUser({ email, password, role, allowed_pages: pagesArg(pages) });
            console.log(`dibuat: ${user.email} (${user.role}; ${user.allowed_pages.join(',')})`);
            console.log(`password: ${password}`);
            return;
        }
        case 'reset-password': {
            if (!email) throw new Error(USAGE);
            const password = generatePassword();
            const user = await resetPassword(email, password);
            console.log(`password baru untuk ${user.email}: ${password}`);
            return;
        }
        case 'access': {
            if (!email || !role) throw new Error(USAGE);
            const user = await setUserAccess(email, role, pagesArg(pages));
            console.log(`${user.email}: ${user.role}; ${user.allowed_pages.join(',')}`);
            return;
        }
        case 'disable':
        case 'enable': {
            if (!email) throw new Error(USAGE);
            const user = await setUserActive(email, cmd === 'enable');
            console.log(`${user.email}: ${user.is_active ? 'aktif' : 'nonaktif (semua sesi dicabut)'}`);
            return;
        }
        default:
            throw new Error(USAGE);
    }
};

main()
    .catch(err => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
