import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import api from './routes/api.js';
import { syncMonth, currentPeriod, startAutoSync } from './sync.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);          // Render/Vercel терминируют TLS перед приложением
app.use(express.json({ limit: '256kb' }));

// Точка для внешнего планировщика (Render Cron, cron-job.org, GitHub Actions).
// Защищена отдельным секретом, чтобы не требовать пароль администратора.
app.get('/api/cron/sync', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(404).json({ error: 'CRON_SECRET не задан' });
  const given = Buffer.from(String(req.query.key || ''));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }
  const { month, year } = currentPeriod();
  try {
    const r = await syncMonth({ month, year, source: 'cron' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', api);
app.use(express.static(path.join(dir, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(dir, '..', 'public', 'index.html')));

// Наружу отдаём только общее сообщение: детали ошибки остаются в логах сервера.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const port = process.env.PORT || 3000;
migrate()
  .then(() => {
    app.listen(port, () => console.log(`Vilgane слушает :${port}`));
    startAutoSync();
  })
  .catch((e) => {
    console.error('Не удалось применить схему БД:', e.message);
    process.exit(1);
  });
