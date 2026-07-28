import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, passwordMatches, issueSession, clearSession, isLoggedIn } from '../auth.js';
import { syncMonth, currentPeriod } from '../sync.js';
import { checkToken, activityName } from '../giriton.js';
import { syncNames } from '../names.js';

const router = Router();

const period = (src) => {
  const now = currentPeriod();
  const month = parseInt(src.month, 10) || now.month;
  const year = parseInt(src.year, 10) || now.year;
  return { month: Math.min(12, Math.max(1, month)), year };
};
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* ---------- сессия ---------- */

router.get('/session', (req, res) => {
  res.json({
    authenticated: isLoggedIn(req),
    activity: activityName(),
    configured: !!process.env.GIRITON_API_TOKEN,
  });
});

router.post('/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD не задан на сервере' });
  }
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  issueSession(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

router.use(requireAuth);

/* ---------- таблица месяца ---------- */

router.get('/rows', async (req, res) => {
  const { month, year } = period(req.query);
  const { rows } = await query(
    `SELECT w.id, w.person_number, w.card_id, w.name, w.giriton_name, w.rate, w.note,
            w.name_source, w.sheet_status,
            COALESCE(a.hours, 0)      AS hours,
            a.activity, a.activities, a.synced_at,
            COALESCE(adv.total, 0)    AS advances_total,
            COALESCE(adv.cnt, 0)::int AS advances_count
       FROM workers w
       LEFT JOIN attendance a
              ON a.worker_id = w.id AND a.year = $2 AND a.month = $1
       LEFT JOIN (SELECT worker_id, SUM(amount) total, COUNT(*) cnt
                    FROM advances WHERE year = $2 AND month = $1
                   GROUP BY worker_id) adv
              ON adv.worker_id = w.id
      WHERE w.archived = FALSE AND (a.id IS NOT NULL OR adv.worker_id IS NOT NULL OR w.name <> '')
      ORDER BY w.person_number`,
    [month, year]);

  const items = rows.map((r) => {
    const gross = money(r.hours * r.rate);
    return { ...r, gross, payout: money(gross - r.advances_total) };
  });

  const totals = items.reduce((a, r) => ({
    hours: money(a.hours + r.hours),
    gross: money(a.gross + r.gross),
    advances: money(a.advances + r.advances_total),
    payout: money(a.payout + r.payout),
  }), { hours: 0, gross: 0, advances: 0, payout: 0 });

  const last = await query('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 1');
  res.json({
    month, year, items, totals,
    activity: activityName(),
    names_sheet: !!process.env.NAMES_SHEET_URL,
    last_sync: last.rows[0] || null,
  });
});

router.get('/years', async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT year FROM (
        SELECT year FROM attendance UNION SELECT year FROM advances
     ) y ORDER BY year DESC`);
  const years = rows.map((r) => r.year);
  const now = currentPeriod().year;
  if (!years.includes(now)) years.unshift(now);
  res.json(years);
});

/* ---------- ручные поля сотрудника ---------- */

router.patch('/workers/:id', async (req, res) => {
  const fields = [];
  const values = [];
  for (const key of ['name', 'note']) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = $${fields.length + 1}`);
      values.push(String(req.body[key]).slice(0, 300));
    }
  }
  // Правка руками закрепляет имя: таблица его больше не перезапишет.
  // Очистили поле — снова отдаём имя на откуп таблице.
  if (req.body.name !== undefined) {
    fields.push(`name_source = $${fields.length + 1}`);
    values.push(String(req.body.name).trim() ? 'manual' : '');
  }
  if (req.body.rate !== undefined) {
    const rate = Number(req.body.rate);
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'Некорректная ставка' });
    fields.push(`rate = $${fields.length + 1}`);
    values.push(money(rate));
  }
  if (!fields.length) return res.status(400).json({ error: 'Нечего обновлять' });

  values.push(req.params.id);
  const { rows } = await query(
    `UPDATE workers SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length} RETURNING *`, values);
  if (!rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
  res.json(rows[0]);
});

/* ---------- авансы ---------- */

router.get('/workers/:id/advances', async (req, res) => {
  const { month, year } = period(req.query);
  const { rows } = await query(
    `SELECT * FROM advances WHERE worker_id = $1 AND month = $2 AND year = $3
      ORDER BY paid_on DESC, created_at DESC`, [req.params.id, month, year]);
  res.json(rows);
});

router.post('/advances', async (req, res) => {
  const { month, year } = period(req.body);
  const amount = Number(req.body.amount);
  if (!req.body.worker_id) return res.status(400).json({ error: 'Не указан сотрудник' });
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Укажите сумму аванса' });

  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_on || '') ? req.body.paid_on : null;
  const { rows } = await query(
    `INSERT INTO advances (worker_id, month, year, amount, comment, paid_on)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::date, CURRENT_DATE)) RETURNING *`,
    [req.body.worker_id, month, year, money(amount), String(req.body.comment || '').slice(0, 500), paidOn]);
  res.status(201).json(rows[0]);
});

router.patch('/advances/:id', async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Укажите сумму аванса' });
  const { rows } = await query(
    `UPDATE advances SET amount = $1, comment = $2 WHERE id = $3 RETURNING *`,
    [money(amount), String(req.body.comment || '').slice(0, 500), req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Аванс не найден' });
  res.json(rows[0]);
});

router.delete('/advances/:id', async (req, res) => {
  const r = await query('DELETE FROM advances WHERE id = $1', [req.params.id]);
  res.json({ ok: true, deleted: r.rowCount });
});

/* ---------- синхронизация ---------- */

router.post('/sync', async (req, res) => {
  const { month, year } = period(req.body);
  try {
    const r = await syncMonth({ month, year, source: 'manual' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Отдельная синхронизация имён из Google-таблицы, без обращения к GIRITON.
router.post('/sync/names', async (req, res) => {
  if (!process.env.NAMES_SHEET_URL) return res.status(400).json({ error: 'NAMES_SHEET_URL не задан' });
  try {
    res.json({ ok: true, ...(await syncNames()) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/sync/check', async (req, res) => {
  const token = process.env.GIRITON_API_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: 'GIRITON_API_TOKEN не задан' });
  try {
    await checkToken(token);
    res.json({ ok: true, activity: activityName() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/sync/log', async (req, res) => {
  const { rows } = await query('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 20');
  res.json(rows);
});

/* ---------- выгрузка ---------- */

router.get('/export.csv', async (req, res) => {
  const { month, year } = period(req.query);
  const { rows } = await query(
    `SELECT w.person_number, w.card_id, w.name, w.giriton_name, w.rate,
            COALESCE(a.hours,0) hours, COALESCE(adv.total,0) advances
       FROM workers w
       LEFT JOIN attendance a ON a.worker_id = w.id AND a.year=$2 AND a.month=$1
       LEFT JOIN (SELECT worker_id, SUM(amount) total FROM advances
                   WHERE year=$2 AND month=$1 GROUP BY worker_id) adv ON adv.worker_id = w.id
      WHERE a.id IS NOT NULL OR adv.worker_id IS NOT NULL
      ORDER BY w.person_number`, [month, year]);

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['ID', 'Карта', 'Имя', 'Имя в GIRITON', 'Часы', 'Ставка', 'Начислено', 'Авансы', 'К выплате'].join(';')];
  for (const r of rows) {
    const gross = money(r.hours * r.rate);
    lines.push([r.person_number, r.card_id, r.name, r.giriton_name, r.hours, r.rate, gross, r.advances, money(gross - r.advances)]
      .map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vilgane-${year}-${String(month).padStart(2, '0')}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

export default router;
