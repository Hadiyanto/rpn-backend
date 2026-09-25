import { pool } from '../config/db';

export interface UserRole {
    user_id: string;
    email: string;
    role: string;
    allowed_pages: string[];
}

const DEFAULT_ROLE: Omit<UserRole, 'user_id' | 'email'> = {
    role: 'staff',
    allowed_pages: ['orders', 'sales', 'stock'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getUserRole = async (userId: string): Promise<UserRole | null> => {
    // user_id is a uuid column; a malformed id simply has no role (supabase-js returned an error → null).
    if (!UUID_RE.test(userId)) return null;
    const { rows } = await pool.query('SELECT * FROM user_roles WHERE user_id = $1', [userId]);
    return (rows[0] as UserRole) ?? null;
};

export const getUserRoleOrDefault = async (userId: string, email?: string): Promise<UserRole> => {
    const role = await getUserRole(userId);
    if (role) return role;
    return {
        user_id: userId,
        email: email ?? '',
        ...DEFAULT_ROLE,
    };
};
