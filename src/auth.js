// Вход одним паролем. Сессия — подписанная HMAC кука, без внешних зависимостей.
import crypto from 'node:crypto';
import { getSetting } from './settings.js';

const COOKIE = 'vilgane_session';
const MAX_AGE_DAYS = 30;

// Ключ подписи: из окружения, иначе постоянный случайный, сохранённый в настройках.
// Привязывать его к паролю нельзя — смена пароля разлогинивала бы по-тихому.
const secret = () => process.env.SESSION_SECRET || getSetting('session_secret') || '';

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(value) {
  if (!value || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

export { checkAdminPassword as passwordMatches } from './settings.js';

export function issueSession(res) {
  const token = sign({ exp: Date.now() + MAX_AGE_DAYS * 864e5 });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_DAYS * 864e5,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isLoggedIn(req) {
  return !!verify(cookies(req)[COOKIE]);
}

// Читать таблицу можно только после входа; на публичном хостинге иначе часы увидит кто угодно.
export function requireAuth(req, res, next) {
  if (isLoggedIn(req)) return next();
  res.status(401).json({ error: 'Требуется вход' });
}
