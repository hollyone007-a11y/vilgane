// Клиент GIRITON REST API.
// Авторизация — постоянный токен компании в заголовке `giriton-token`.
// Токен создаётся один раз в GIRITON: Nastavení → Spárovaná zařízení → REST API token.
// Спецификация: https://rest.giriton.com/apidoc/

const BASE = process.env.GIRITON_API_URL || 'https://rest.giriton.com/system/api';

// Показатель докладки, который считаем «часами».
export const DEFAULT_ACTIVITY = 'Práce (celkem)';
export const activityName = () => process.env.GIRITON_ACTIVITY || DEFAULT_ACTIVITY;

const pad = (n) => String(n).padStart(2, '0');

export function monthRange(month, year) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { dateFrom: `${year}-${pad(month)}-01`, dateTo: `${year}-${pad(month)}-${pad(last)}` };
}

// GIRITON отдаёт длительность либо десятичной ("42.55" / "42,55"), либо как "H:MM" / "HH:MM:SS".
export function parseHours(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, '');
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => Math.abs(parseFloat(x.replace(',', '.'))) || 0);
    const [h, m = 0, sec = 0] = parts;
    return (s.startsWith('-') ? -1 : 1) * (h + m / 60 + sec / 3600);
  }
  const n = parseFloat(s.replace(/[^0-9,.\-]/g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

async function apiGet(path, params, token) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url, { headers: { 'giriton-token': token, Accept: 'application/json' } });
  if (r.status === 401) throw new Error('GIRITON: токен отклонён (401). Проверьте GIRITON_API_TOKEN.');
  if (r.status === 423) throw new Error('GIRITON: слишком много запросов с неверным токеном (423), подождите.');
  if (r.status === 429) throw new Error('GIRITON: превышен лимит запросов (429).');
  if (!r.ok) throw new Error(`GIRITON: HTTP ${r.status}`);
  return r.json();
}

function mapItems(items, wantedName) {
  const wanted = wantedName.trim().toLowerCase();
  return items.map((it) => {
    const p = it.person || {};
    const results = (it.monthlyAttendanceResults || []).flatMap((m) => m.activityResults || []);
    const activities = {};
    for (const ar of results) {
      const n = ar.activity?.name;
      if (n) activities[n] = ar.value;
    }
    const hit = results.find((ar) => (ar.activity?.name || '').trim().toLowerCase() === wanted);
    return {
      person_number: p.number != null && p.number !== '' ? String(p.number) : String(p.id ?? ''),
      giriton_person_id: p.id != null ? String(p.id) : null,
      card_id: (p.presenceCardIds || []).join(',') || null,
      giriton_name: [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email || '',
      hours: parseHours(hit?.value) ?? 0,
      activity: hit?.activity?.name || wantedName,
      activities,
    };
  }).filter((r) => r.person_number);
}

// Тянет месячные итоги докладки по всем сотрудникам (с постраничным обходом).
export async function fetchMonth({ month, year, token, activity = activityName() }) {
  const { dateFrom, dateTo } = monthRange(month, year);
  const rows = [];
  let offset = 0;
  const limit = 200; // максимум, разрешённый API
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await apiGet('/attendance/attendanceData', {
      dateFrom, dateTo, offset, limit, includeAttendanceMonthlyResults: true,
    }, token);
    const items = page.items || [];
    rows.push(...mapItems(items, activity));
    const total = page.pagination?.totalCount ?? page.pagination?.total;
    offset += items.length;
    if (!items.length || items.length < limit || (total != null && offset >= total)) break;
  }
  return { rows, dateFrom, dateTo, activity };
}

export async function checkToken(token) {
  const { dateFrom } = monthRange(new Date().getMonth() + 1, new Date().getFullYear());
  await apiGet('/hr/usersEmployedBetween', { employedFrom: dateFrom, employedTo: dateFrom, limit: 1 }, token);
  return true;
}
