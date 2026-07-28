// Применяет schema.sql вручную: `npm run migrate`.
// В обычном режиме это делает сам сервер при старте.
import { migrate, pool } from './db.js';

migrate()
  .then(() => console.log('Схема применена.'))
  .catch((e) => { console.error('Ошибка:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
