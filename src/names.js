// Синхронизация имён из Google-таблицы со списком сотрудников.
// Таблица — источник имён; всё, что исправлено руками на сайте, остаётся нетронутым.
import { query } from './db.js';
import { getSetting } from './settings.js';

// Принимает любую ссылку на таблицу (в том числе обычную «поделиться») и приводит её
// к CSV-выгрузке. gviz работает и для загруженных .xlsx, в отличие от /export?format=csv.
export function toCsvUrl(input) {
  const url = String(input || '').trim();
  if (!url) return '';
  if (/\/gviz\/tq|format=csv|output=csv/.test(url)) return url;
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) return url;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid ? `&gid=${gid}` : ''}`;
}

// Разбор CSV с учётом кавычек и переводов строк внутри ячеек.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Ищем нужные колонки по названию — порядок и лишние столбцы в таблице значения не имеют.
// Заголовки в кириллице, поэтому никаких \w: он матчит только латиницу.
// Длинные ячейки пропускаем: в таких таблицах первая колонка часто содержит заголовок
// всего листа («СПИСОК СОТРУДНИКОВ, НОМЕРА, ЧИПЫ И EMAIL …») и ложно ловится на «email».
const TITLE_MAX = 30;

function locateColumns(header) {
  const idx = { key: -1, first: -1, last: -1, full: -1, email: -1, status: -1 };
  header.forEach((raw, i) => {
    const h = norm(raw);
    if (!h || h.length > TITLE_MAX) return;
    if (idx.key < 0 && /складск|табельн|личный номер|номер сотрудника|^id$|^номер$|^№$/.test(h)) idx.key = i;
    if (idx.full < 0 && /фио|полное имя/.test(h)) idx.full = i;
    if (idx.first < 0 && /^имя$/.test(h)) idx.first = i;
    if (idx.last < 0 && /^фамилия$/.test(h)) idx.last = i;
    if (idx.email < 0 && /e-?mail|почта/.test(h)) idx.email = i;
    if (idx.status < 0 && /статус/.test(h)) idx.status = i;
  });
  return idx;
}

// Из «AUR_S05_1009» достаём и полный ключ, и голый ID — GIRITON может отдавать любой из них.
function splitKey(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;
  const m = key.match(/^(.*?)[_-]?(\d{2,})$/);
  return { key, card: m?.[1]?.replace(/[_-]$/, '') || null, id: m?.[2] || (/^\d+$/.test(key) ? key : null) };
}

export function parseNamesSheet(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { people: [], columns: null };

  // Шапка не всегда в первой строке — ищем строку, где нашлась колонка с номером.
  let headerRow = 0;
  let cols = locateColumns(rows[0]);
  for (let i = 0; i < Math.min(rows.length, 8) && cols.key < 0; i += 1) {
    cols = locateColumns(rows[i]);
    headerRow = i;
  }
  if (cols.key < 0) return { people: [], columns: null };

  const people = [];
  for (const r of rows.slice(headerRow + 1)) {
    const parts = splitKey(r[cols.key]);
    if (!parts || !parts.id) continue;
    const name = (cols.full >= 0 && r[cols.full]?.trim())
      || [r[cols.first], r[cols.last]].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
    if (!name) continue;
    people.push({
      ...parts,
      name: name.trim(),
      email: (cols.email >= 0 ? String(r[cols.email] || '').trim() : '') || null,
      status: (cols.status >= 0 ? String(r[cols.status] || '').trim() : '') || '',
    });
  }
  return { people, columns: cols };
}

export async function fetchNamesSheet(url) {
  const csv = toCsvUrl(url);
  if (!csv) throw new Error('Ссылка на таблицу не задана. Откройте «Настройки» и вставьте её.');
  const r = await fetch(csv, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Таблица недоступна: HTTP ${r.status}. Проверьте, что доступ «для всех, у кого есть ссылка».`);
  const text = await r.text();
  if (/^\s*</.test(text)) throw new Error('Вместо CSV пришла HTML-страница — у таблицы закрыт доступ по ссылке.');
  const { people } = parseNamesSheet(text);
  if (!people.length) throw new Error('В таблице не найдено ни одной строки с номером и именем.');
  return people;
}

// Раскладывает имена по уже известным сотрудникам и заводит недостающих.
// Имя не трогаем, если его правили руками (name_source = 'manual').
export async function syncNames(url = getSetting('names_sheet_url')) {
  const people = await fetchNamesSheet(url);
  let updated = 0;
  let created = 0;

  const { rows: workers } = await query('SELECT id, person_number, card_id, name_source FROM workers');
  const byNumber = new Map(workers.map((w) => [String(w.person_number).toLowerCase(), w]));

  for (const p of people) {
    // GIRITON может отдавать номер как «1009», так и как «AUR_S05_1009».
    const match = byNumber.get(p.key.toLowerCase()) || byNumber.get(p.id.toLowerCase());

    if (!match) {
      await query(
        `INSERT INTO workers (person_number, card_id, name, name_source, sheet_status, sheet_email)
         VALUES ($1,$2,$3,'sheet',$4,$5)
         ON CONFLICT (person_number) DO NOTHING`,
        [p.id, p.card, p.name, p.status, p.email]);
      created += 1;
      continue;
    }
    const r = await query(
      `UPDATE workers
          SET name         = CASE WHEN name_source = 'manual' THEN name ELSE $2 END,
              name_source  = CASE WHEN name_source = 'manual' THEN 'manual' ELSE 'sheet' END,
              card_id      = COALESCE(card_id, $3),
              sheet_status = $4,
              sheet_email  = $5,
              updated_at   = NOW()
        WHERE id = $1`,
      [match.id, p.name, p.card, p.status, p.email]);
    updated += r.rowCount;
  }
  return { people: people.length, updated, created };
}
