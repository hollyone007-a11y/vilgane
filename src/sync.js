// Перенос данных из GIRITON в БД: сотрудники (ID/карта) + часы за месяц.
// Ручные поля — имя, ставка, комментарий — НИКОГДА не перезаписываются синхронизацией.
import { query } from './db.js';
import { fetchMonth, activityName, apiToken } from './giriton.js';
import { syncNames } from './names.js';
import { getSetting } from './settings.js';

export function currentPeriod() {
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

export async function syncMonth({ month, year, source = 'manual' }) {
  const token = apiToken();
  if (!token) throw new Error('Токен GIRITON не задан. Откройте «Настройки» и вставьте REST API токен.');

  let data;
  try {
    data = await fetchMonth({ month, year, token, activity: activityName() });
  } catch (e) {
    await log({ month, year, ok: false, workers: 0, message: e.message, source });
    throw e;
  }

  for (const r of data.rows) {
    // Сотрудник заводится один раз; при повторной синхронизации обновляем только данные из GIRITON.
    const w = await query(
      `INSERT INTO workers (person_number, giriton_person_id, card_id, giriton_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (person_number) DO UPDATE
         SET giriton_person_id = EXCLUDED.giriton_person_id,
             card_id           = COALESCE(EXCLUDED.card_id, workers.card_id),
             giriton_name      = EXCLUDED.giriton_name,
             archived          = FALSE,
             updated_at        = NOW()
       RETURNING id`,
      [r.person_number, r.giriton_person_id, r.card_id, r.giriton_name]);

    await query(
      `INSERT INTO attendance (worker_id, month, year, hours, activity, activities, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (worker_id, year, month) DO UPDATE
         SET hours = EXCLUDED.hours, activity = EXCLUDED.activity,
             activities = EXCLUDED.activities, synced_at = NOW()`,
      [w.rows[0].id, month, year, r.hours, r.activity, JSON.stringify(r.activities)]);
  }

  // Имена подтягиваем следом, чтобы новые ID из GIRITON сразу получили ФИО из таблицы.
  let names = null;
  if (getSetting('names_sheet_url')) {
    try {
      names = await syncNames();
    } catch (e) {
      names = { error: e.message };
    }
  }

  await log({ month, year, ok: true, workers: data.rows.length, message: `${data.dateFrom} — ${data.dateTo}`, source });
  return { count: data.rows.length, ...data, rows: undefined, names };
}

async function log({ month, year, ok, workers, message, source }) {
  await query(
    'INSERT INTO sync_log (month, year, ok, workers, message, source) VALUES ($1,$2,$3,$4,$5,$6)',
    [month, year, ok, workers, String(message).slice(0, 500), source]);
}

// Фоновая автосинхронизация текущего месяца: «информация переносится сама».
let timer = null;

const runOnce = () => {
  if (!apiToken()) return;                    // токен ещё не введён — просто ждём
  const { month, year } = currentPeriod();
  syncMonth({ month, year, source: 'auto' })
    .then((r) => console.log(`[autosync] ${month}.${year}: ${r.count} сотрудников`))
    .catch((e) => console.error('[autosync]', e.message));
};

// Вызывается при старте и после сохранения настроек: интервал и токен меняются на лету,
// перезапускать сервис ради этого не нужно.
export function startAutoSync() {
  if (timer) { clearInterval(timer); timer = null; }
  const minutes = parseInt(getSetting('sync_interval_minutes'), 10);
  if (!minutes || minutes < 1) return console.log('Автосинхронизация выключена');

  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref?.();
  setTimeout(runOnce, 10_000).unref?.();       // первый прогон вскоре после старта
  console.log(`Автосинхронизация GIRITON каждые ${minutes} мин.`);
}
