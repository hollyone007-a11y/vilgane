import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const dir = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('DATABASE_URL не задан — приложение не может стартовать.');
  process.exit(1);
}
// Managed Postgres (Render, Neon, Supabase) требует TLS; локальный — нет.
const local = /localhost|127\.0\.0\.1/.test(url);

export const pool = new Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 5,
});

// NUMERIC приходит из pg строкой — приводим к числу, чтобы не городить parseFloat везде.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE по умолчанию превращается в Date с локальной полуночью и при сериализации в JSON
// съезжает на сутки в другом часовом поясе. Оставляем как есть — 'YYYY-MM-DD'.
pg.types.setTypeParser(1082, (v) => v);

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  const sql = await fs.readFile(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
