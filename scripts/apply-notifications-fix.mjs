import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const sqlPath = path.join(process.cwd(), 'supabase/migrations/20260914_notifications_phase9_fix.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query(
    `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
    ['20260914_notifications_phase9_fix.sql']
  );
  await client.query('COMMIT');
  console.log('Applied notifications phase9 fix successfully.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
