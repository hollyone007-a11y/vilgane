// Перенос данных из GIRITON в БД: сотрудники (ID/карта) + часы за месяц.
// Ручные поля — имя, ставка, комментарий — НИКОГДА не перезаписываются синхронизацией.
import { query } from './db.js';
import { fetchMonth, activityName } from './giriton.js';

export function currentPeriod() {
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

export async function syncMonth({ month, year, source = 'manual' }) {
  const token = process.env.GIRITON_API_TOKEN;
  if (!token) throw new Error('GIRITON_API_TOKEN не задан в переменных окружения.');

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

  await log({ month, year, ok: true, workers: data.rows.length, message: `${data.dateFrom} — ${data.dateTo}`, source });
  return { count: data.rows.length, ...data, rows: undefined };
}

async function log({ month, year, ok, workers, message, source }) {
  await query(
    'INSERT INTO sync_log (month, year, ok, workers, message, source) VALUES ($1,$2,$3,$4,$5,$6)',
    [month, year, ok, workers, String(message).slice(0, 500), source]);
}

// Фоновая автосинхронизация текущего месяца: «информация переносится сама».
export function startAutoSync() {
  const minutes = parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '60', 10);
  if (!minutes || minutes < 1) return console.log('Автосинхронизация выключена (SYNC_INTERVAL_MINUTES=0)');
  if (!process.env.GIRITON_API_TOKEN) return console.log('Автосинхронизация не запущена: нет GIRITON_API_TOKEN');

  const run = () => {
    const { month, year } = currentPeriod();
    syncMonth({ month, year, source: 'auto' })
      .then((r) => console.log(`[autosync] ${month}.${year}: ${r.count} сотрудников`))
      .catch((e) => console.error('[autosync]', e.message));
  };
  setTimeout(run, 10_000).unref?.();          // первый прогон вскоре после старта
  setInterval(run, minutes * 60_000).unref?.();
  console.log(`Автосинхронизация GIRITON каждые ${minutes} мин.`);
}
