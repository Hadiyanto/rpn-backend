// Read-only backup: exports every table in the public schema to CSV.
// Output: backups/<timestamp>/<table>.csv (gitignored). Uses DATABASE_URL from .env.
// Usage: npx ts-node scripts/backup-csv.ts
//
// CSV is for reading/spot-checking. For a restorable backup also run:
//   pg_dump "$DATABASE_URL" -Fc -f backups/rpn-$(date +%Y%m%d-%H%M).dump
import fs from 'fs';
import path from 'path';
import { pool } from '../src/config/db';

const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function main() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '..', 'backups', stamp);
    fs.mkdirSync(dir, { recursive: true });

    const { rows: tables } = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );

    for (const { tablename } of tables) {
        const { rows, fields } = await pool.query(`SELECT * FROM public."${tablename}"`);
        const header = fields.map(f => csvCell(f.name)).join(',');
        const lines = rows.map(r => fields.map(f => csvCell(r[f.name])).join(','));
        fs.writeFileSync(path.join(dir, `${tablename}.csv`), [header, ...lines].join('\n') + '\n');
        console.log(`${tablename}: ${rows.length} rows`);
    }

    console.log(`\nSaved to ${dir}`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
