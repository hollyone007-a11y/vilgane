// Настройки приложения живут в БД и правятся на самом сайте — чтобы после развёртывания
// не нужно было ничего вписывать в панель хостинга. Переменная окружения, если задана,
// имеет приоритет: так можно жёстко зафиксировать значение на проде.
import crypto from 'node:crypto';
import { query } from './db.js';

const cache = new Map();

// ключ настройки -> переменная окружения, которая его перекрывает
const ENV = {
  giriton_token: 'GIRITON_API_TOKEN',
  giriton_activity: 'GIRITON_ACTIVITY',
  names_sheet_url: 'NAMES_SHEET_URL',
  sync_interval_minutes: 'SYNC_INTERVAL_MINUTES',
};

const DEFAULTS = {
  giriton_activity: 'Práce (celkem)',
  sync_interval_minutes: '60',
};

export async function loadSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
}

export function getSetting(key) {
  const env = ENV[key] ? process.env[ENV[key]] : undefined;
  if (env !== undefined && env !== '') return env;
  const v = cache.get(key);
  return v !== undefined && v !== '' ? v : (DEFAULTS[key] ?? '');
}

// Значение, зафиксированное окружением, с сайта менять нельзя — иначе правка молча ни на что не влияет.
export function isLockedByEnv(key) {
  return !!(ENV[key] && process.env[ENV[key]]);
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value ?? '')]);
  cache.set(key, String(value ?? ''));
}

/* ---------- пароль администратора ---------- */

const scrypt = (password, salt) => crypto.scryptSync(String(password), salt, 32);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scrypt(password, salt).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const a = scrypt(password, salt);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Ключ подписи кук должен пережить перезапуск, иначе всех разлогинивает при каждом деплое.
export async function ensureSessionSecret() {
  if (process.env.SESSION_SECRET || getSetting('session_secret')) return;
  await setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
}

// При первом запуске пароля ещё нет: генерируем и показываем в логах.
// Так развёртывание не требует ни одного заранее заданного секрета.
export async function ensureAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return null;
  if (getSetting('admin_password_hash')) return null;

  const password = crypto.randomBytes(9).toString('base64url');
  await setSetting('admin_password_hash', hashPassword(password));
  const line = '─'.repeat(52);
  console.log(`\n${line}\n  ПАРОЛЬ ДЛЯ ПЕРВОГО ВХОДА: ${password}\n` +
              `  Смените его на сайте: Настройки → Пароль\n${line}\n`);
  return password;
}

export function checkAdminPassword(input) {
  const value = String(input ?? '');
  const env = process.env.ADMIN_PASSWORD;
  if (env) {
    const a = crypto.createHash('sha256').update(value).digest();
    const b = crypto.createHash('sha256').update(env).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const stored = getSetting('admin_password_hash');
  return stored ? verifyPassword(value, stored) : false;
}
