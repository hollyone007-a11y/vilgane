'use strict';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Дата приходит строкой 'YYYY-MM-DD'; через Date она бы съезжала на сутки при другом часовом поясе.
const fmtDate = (s) => String(s ?? '').slice(0, 10).split('-').reverse().join('.');

const state = { month: 0, year: 0, items: [], totals: null, search: '', worker: null };

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { showLogin(); throw new Error('Требуется вход'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || `Ошибка ${r.status}`);
  return data;
}

/* ---------- вход ---------- */

function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/login', { password: $('#password').value });
    $('#password').value = '';
    showApp();
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

/* ---------- период ---------- */

function fillPeriod(years) {
  const m = $('#month');
  m.innerHTML = MONTHS.map((name, i) => `<option value="${i + 1}">${name}</option>`).join('');
  m.value = state.month;
  const y = $('#year');
  y.innerHTML = years.map((v) => `<option value="${v}">${v}</option>`).join('');
  y.value = state.year;
}

$('#month').addEventListener('change', (e) => { state.month = +e.target.value; load(); });
$('#year').addEventListener('change', (e) => { state.year = +e.target.value; load(); });
$('#search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });

/* ---------- данные ---------- */

async function load() {
  const data = await api('GET', `/api/rows?month=${state.month}&year=${state.year}`);
  state.items = data.items;
  state.totals = data.totals;
  state.activity = data.activity;
  $('#btn-export').href = `/api/export.csv?month=${state.month}&year=${state.year}`;

  const s = data.last_sync;
  $('#sync-info').textContent = s
    ? `Последняя синхронизация: ${new Date(s.created_at).toLocaleString('ru-RU')}` +
      (s.ok ? ` · ${s.workers} чел. · ${data.activity}` : ` · ошибка: ${s.message}`)
    : 'Синхронизации ещё не было';
  render();
}

function visible() {
  if (!state.search) return state.items;
  return state.items.filter((r) => [r.person_number, r.card_id, r.name, r.giriton_name]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(state.search)));
}

function render() {
  const rows = visible();
  const t = state.totals || { hours: 0, gross: 0, advances: 0, payout: 0 };
  $('#s-count').textContent = state.items.length;
  $('#s-hours').textContent = fmt(t.hours);
  $('#s-gross').textContent = fmt(t.gross);
  $('#s-adv').textContent = fmt(t.advances);
  $('#s-payout').textContent = fmt(t.payout);

  const empty = $('#empty');
  if (!state.items.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = 'Данных за этот месяц нет.<br><span class="small">Нажмите «Синхронизировать», чтобы подтянуть докладку из GIRITON.</span>';
  } else if (!rows.length) {
    empty.classList.remove('hidden');
    empty.textContent = 'Ничего не найдено.';
  } else {
    empty.classList.add('hidden');
  }

  $('#tbody').innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td class="mono"><b>${esc(r.person_number)}</b></td>
      <td class="mono small muted">${esc(r.card_id || '—')}</td>
      <td>
        <input class="cell-input js-name ${r.name ? '' : 'name-missing'}" value="${esc(r.name)}"
               placeholder="${esc(r.giriton_name || 'вписать имя')}" maxlength="300" />
      </td>
      <td class="right mono">${fmt(r.hours)}</td>
      <td class="right">
        <input class="cell-input num js-rate" type="number" min="0" step="1" value="${r.rate || ''}" placeholder="0" />
      </td>
      <td class="right mono">${fmt(r.gross)}</td>
      <td class="right">
        <button class="pill js-adv ${r.advances_total ? 'has' : ''}">
          ${r.advances_total ? fmt(r.advances_total) : '+ аванс'}${r.advances_count ? ` · ${r.advances_count}` : ''}
        </button>
      </td>
      <td class="right mono payout">${fmt(r.payout)}</td>
    </tr>`).join('');

  $('#tfoot').innerHTML = state.items.length ? `
    <tr>
      <td colspan="3">Итого${state.search ? ' (по фильтру)' : ''}</td>
      <td class="right mono">${fmt(sum(rows, 'hours'))}</td>
      <td></td>
      <td class="right mono">${fmt(sum(rows, 'gross'))}</td>
      <td class="right mono warn">${fmt(sum(rows, 'advances_total'))}</td>
      <td class="right mono payout">${fmt(sum(rows, 'payout'))}</td>
    </tr>` : '';
}

const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

/* ---------- правка имени и ставки ---------- */

$('#tbody').addEventListener('focusout', async (e) => {
  const input = e.target;
  const isName = input.classList.contains('js-name');
  const isRate = input.classList.contains('js-rate');
  if (!isName && !isRate) return;

  const id = input.closest('tr').dataset.id;
  const row = state.items.find((r) => r.id === id);
  if (!row) return;

  const patch = isName ? { name: input.value.trim() } : { rate: Number(input.value) || 0 };
  const current = isName ? row.name : Number(row.rate) || 0;
  const next = isName ? patch.name : patch.rate;
  if (String(current) === String(next)) return;

  try {
    await api('PATCH', `/api/workers/${id}`, patch);
    Object.assign(row, patch);
    row.gross = Math.round(row.hours * row.rate * 100) / 100;
    row.payout = Math.round((row.gross - row.advances_total) * 100) / 100;
    recomputeTotals();
    flash(input);
    render();
  } catch (ex) {
    alert(ex.message);
  }
});

$('#tbody').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('cell-input')) e.target.blur();
});

function flash(el) {
  el.classList.add('saved');
  setTimeout(() => el.classList.remove('saved'), 900);
}

function recomputeTotals() {
  state.totals = {
    hours: sum(state.items, 'hours'),
    gross: sum(state.items, 'gross'),
    advances: sum(state.items, 'advances_total'),
    payout: sum(state.items, 'payout'),
  };
}

/* ---------- авансы ---------- */

$('#tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.js-adv');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  openDrawer(state.items.find((r) => r.id === id));
});

async function openDrawer(row) {
  state.worker = row;
  $('#d-title').textContent = row.name || row.giriton_name || `ID ${row.person_number}`;
  $('#d-sub').textContent = `ID ${row.person_number}${row.card_id ? ` · ${row.card_id}` : ''} · ${MONTHS[state.month - 1]} ${state.year}`;
  $('#adv-amount').value = '';
  $('#adv-comment').value = '';
  $('#adv-date').value = new Date().toISOString().slice(0, 10);
  $('#adv-error').classList.add('hidden');
  $('#drawer').classList.remove('hidden');
  await loadAdvances();
  $('#adv-amount').focus();
}

function closeDrawer() { $('#drawer').classList.add('hidden'); state.worker = null; }
$('#drawer').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

async function loadAdvances() {
  const list = await api('GET', `/api/workers/${state.worker.id}/advances?month=${state.month}&year=${state.year}`);
  $('#adv-list').innerHTML = list.length ? list.map((a) => `
    <div class="adv-item" data-id="${a.id}">
      <div>
        <div class="adv-sum">${fmt(a.amount)} Kč</div>
        <div class="small muted">${fmtDate(a.paid_on)}</div>
        ${a.comment ? `<div class="small">${esc(a.comment)}</div>` : ''}
      </div>
      <button class="btn danger js-del" title="Удалить">✕</button>
    </div>`).join('') : '<div class="muted small">Авансов за этот месяц нет.</div>';

  // Локально обновляем строку таблицы, чтобы не перезапрашивать весь месяц.
  const total = list.reduce((a, x) => a + Number(x.amount), 0);
  const row = state.worker;
  row.advances_total = Math.round(total * 100) / 100;
  row.advances_count = list.length;
  row.payout = Math.round((row.gross - row.advances_total) * 100) / 100;
  recomputeTotals();
  render();
}

$('#adv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#adv-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/advances', {
      worker_id: state.worker.id,
      month: state.month,
      year: state.year,
      amount: Number($('#adv-amount').value),
      comment: $('#adv-comment').value,
      paid_on: $('#adv-date').value,
    });
    $('#adv-amount').value = '';
    $('#adv-comment').value = '';
    await loadAdvances();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#adv-list').addEventListener('click', async (e) => {
  if (!e.target.closest('.js-del')) return;
  const id = e.target.closest('.adv-item').dataset.id;
  if (!confirm('Удалить этот аванс?')) return;
  await api('DELETE', `/api/advances/${id}`);
  await loadAdvances();
});

/* ---------- синхронизация ---------- */

$('#btn-sync').addEventListener('click', async () => {
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.textContent = 'Синхронизация…';
  try {
    const r = await api('POST', '/api/sync', { month: state.month, year: state.year });
    banner('success', `Перенесено сотрудников: ${r.count} (${r.dateFrom} — ${r.dateTo})`);
    await load();
  } catch (ex) {
    banner('error', ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Синхронизировать';
  }
});

function banner(type, text) {
  $('#banner').innerHTML = `<div class="alert ${type}">${esc(text)}</div>`;
  setTimeout(() => { $('#banner').innerHTML = ''; }, 8000);
}

/* ---------- старт ---------- */

async function boot() {
  const now = new Date();
  if (!state.month) { state.month = now.getMonth() + 1; state.year = now.getFullYear(); }
  const years = await api('GET', '/api/years');
  fillPeriod(years);
  await load();
}

(async function init() {
  const s = await api('GET', '/api/session');
  if (!s.authenticated) return showLogin();
  showApp();
  await boot();
})();
