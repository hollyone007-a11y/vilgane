-- Vilgane: схема БД. Все выражения идемпотентны — файл прогоняется при каждом старте.

-- Настройки приложения: токен GIRITON, ссылка на таблицу имён, пароль администратора.
-- Лежат здесь, а не в переменных окружения, чтобы всё настраивалось на самом сайте.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Сотрудник: ключ приходит из GIRITON (osobní číslo), имя и ставка заполняются вручную.
CREATE TABLE IF NOT EXISTS workers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_number     TEXT NOT NULL,             -- ID из GIRITON, напр. 1009
  giriton_person_id TEXT,
  card_id           TEXT,                      -- ID карты, напр. AUR_S05
  giriton_name      TEXT NOT NULL DEFAULT '',  -- имя как его отдаёт GIRITON (может быть пустым)
  name              TEXT NOT NULL DEFAULT '',  -- имя, вписанное вручную
  rate              NUMERIC(10,2) NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',
  archived          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS workers_person_number_key ON workers(person_number);

-- Источник имени и данные из Google-таблицы со списком сотрудников.
-- name_source = 'manual' означает «правили руками», такое имя таблица не перезаписывает.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS name_source  TEXT NOT NULL DEFAULT '';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS sheet_status TEXT NOT NULL DEFAULT '';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS sheet_email  TEXT;

-- Часы за месяц, полностью перезаписываются синхронизацией.
CREATE TABLE IF NOT EXISTS attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month       SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year        SMALLINT NOT NULL,
  hours       NUMERIC(10,2) NOT NULL DEFAULT 0,
  activity    TEXT NOT NULL DEFAULT '',
  activities  JSONB NOT NULL DEFAULT '{}',     -- все показатели докладки, как есть
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_worker_period_key ON attendance(worker_id, year, month);
CREATE INDEX IF NOT EXISTS attendance_period_idx ON attendance(year, month);

-- Авансы: сколько выдали, когда и с каким комментарием.
CREATE TABLE IF NOT EXISTS advances (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id  UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month      SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year       SMALLINT NOT NULL,
  amount     NUMERIC(12,2) NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',
  paid_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS advances_worker_period_idx ON advances(worker_id, year, month);

-- Журнал синхронизаций — видно, когда последний раз тянули GIRITON и чем закончилось.
CREATE TABLE IF NOT EXISTS sync_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month      SMALLINT NOT NULL,
  year       SMALLINT NOT NULL,
  ok         BOOLEAN NOT NULL,
  workers    INTEGER NOT NULL DEFAULT 0,
  message    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'manual',   -- manual | auto | cron
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sync_log_created_idx ON sync_log(created_at DESC);
