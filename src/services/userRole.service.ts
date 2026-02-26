import { supabase } from '../config/supabase';

export interface UserRole {
    user_id: string;
    email: string;
    role: string;
    allowed_pages: string[];
}

const DEFAULT_ROLE: Omit<UserRole, 'user_id' | 'email'> = {
    role: 'staff',
    allowed_pages: ['orders'],
};

export const getUserRole = async (userId: string): Promise<UserRole | null> => {
    const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error || !data) return null;
    return data as UserRole;
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
