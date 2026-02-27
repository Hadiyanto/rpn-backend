import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE config");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function updateAdminRole() {
    console.log('Fetching all users with role = "admin"...');
    const { data: admins, error: fetchError } = await supabase
        .from('user_roles')
        .select('*')
        .eq('role', 'admin');

    if (fetchError) {
        console.error('Error fetching admins:', fetchError);
        return;
    }

    console.log(`Found ${admins?.length || 0} admins.`);

    for (const admin of admins || []) {
        const currentPages = admin.allowed_pages || [];
        if (!currentPages.includes('summary')) {
            const newPages = [...currentPages, 'summary'];
            console.log(`Updating admin ${admin.email} (ID: ${admin.user_id}) to include 'summary'...`);
            const { error: updateError } = await supabase
                .from('user_roles')
                .update({ allowed_pages: newPages })
                .eq('user_id', admin.user_id);

            if (updateError) {
                console.error(`Failed to update ${admin.email}:`, updateError);
            } else {
                console.log(`Successfully updated ${admin.email}.`);
            }
        } else {
            console.log(`Admin ${admin.email} already has 'summary' access.`);
        }
    }
}

updateAdminRole().catch(console.error);
