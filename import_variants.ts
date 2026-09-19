import * as fs from 'fs';
import { supabase } from './src/config/supabase';

function normalizeVariant(name: string) {
    // Standardize wording
    name = name.replace(/Dengan/g, "Dan").trim();

    // Kalau mengandung Dan tapi belum diawali Mix
    if (name.includes(" Dan ") && !name.startsWith("Mix ")) {
        name = "Mix " + name;
    }

    // Kalau format Mix → sort alfabetis
    if (name.startsWith("Mix ")) {
        const parts = name
            .replace("Mix ", "")
            .split(" Dan ")
            .map(p => p.trim())
            .sort();

        return "Mix " + parts.join(" Dan ");
    }

    return name;
}

async function importVariants() {
    console.log('Reading CSV...');
    const csvValue = fs.readFileSync('/Users/hadiyanto/Downloads/variants.csv', 'utf8');
    const lines = csvValue.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // First line is header: id,variant_name,is_active,created_at,updated_at
    const records = [];

    let maxId = 0;
    const parsedLines = [];

    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < 3) continue; // Skip empty/invalid lines

        let idStr = row[0];
        if (idStr && idStr.trim() !== '') {
            let idNum = parseInt(idStr, 10);
            if (idNum > maxId) maxId = idNum;
        }

        parsedLines.push({
            id: idStr,
            name: row[1],
            isActive: row[2] === 'true',
            created_at: row[3],
            updated_at: row[4]
        });
    }

    // Now build payloads with uniform keys
    for (const r of parsedLines) {
        let payload: any = {
            variant_name: normalizeVariant(r.name),
            is_active: r.isActive,
            // If ID is missing, assign next available ID
            id: (r.id && r.id.trim() !== '') ? parseInt(r.id, 10) : (++maxId),
            created_at: r.created_at || new Date().toISOString(),
            updated_at: r.updated_at || new Date().toISOString()
        };

        records.push(payload);
    }

    console.log(`Parsed ${records.length} records. Max ID before auto-gen: ${maxId - (records.filter(r => r.id > 42).length)}`);

    console.log('Deleting existing variants...');
    const { error: delError } = await supabase.from('variant').delete().neq('id', 0);
    if (delError) {
        console.error('Failed to delete variants:', delError);
        return;
    }

    console.log('Inserting new variants...');
    const { data, error } = await supabase.from('variant').insert(records);
    if (error) {
        console.error('Failed to insert variants:', error);
    } else {
        console.log('Successfully inserted new variants.');
    }
}

importVariants().catch(console.error);
