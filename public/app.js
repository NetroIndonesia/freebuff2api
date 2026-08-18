// freebuff2api dashboard — vanilla JS, no build step.

const DEFAULT_KEY = 'freebuff-default-key';
const apiKey = () => localStorage.getItem('freebuffApiKey') || DEFAULT_KEY;
const apiHeaders = () => ({ 'Content-Type': 'application/json', 'x-api-key': apiKey() });

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = { models: [], accounts: [], proxies: [], quota: null, activity: [] };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- overflow menu
// One reusable "⋯" dropdown: many actions live behind one button; closes on
// outside click, Esc, scroll, or resize.
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function popMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.__anchor = anchor;
  for (const it of items) {
    if (it === '-') { const sep = document.createElement('div'); sep.className = 'menu-sep'; menu.appendChild(sep); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeMenu(); it.fn && it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - mw - 8);
  let y = r.bottom + 4;
  if (y + mh > window.innerHeight - 8) y = r.top - mh - 4;
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  openMenu = menu;
}
function toggleMenu(anchor, items) {
  if (openMenu && openMenu.__anchor === anchor) { closeMenu(); return; }
  popMenu(anchor, items);
}
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !(openMenu.__anchor && openMenu.__anchor.contains(e.target))) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('scroll', () => closeMenu(), true);
window.addEventListener('resize', () => closeMenu());

function logActivity(msg, kind = 'info') {
  state.activity.unshift({ ts: new Date().toLocaleTimeString('en-GB'), msg, kind });
  state.activity = state.activity.slice(0, 120);
  renderActivity();
}
function renderActivity() {
  const el = $('#activity-log');
  if (!el) return;
  el.innerHTML = state.activity.map((l) =>
    `<div class="log-line ${l.kind}"><span class="ts">${esc(l.ts)}</span> <span class="ev">›</span> ${esc(l.msg)}</div>`
  ).join('') || '<div class="empty">no activity</div>';
}

// ---------------------------------------------------------------- api

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...apiHeaders(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
  return data;
}
const getStatus = () => fetch('/api/status').then((r) => r.json()).catch(() => null);
const getAccounts = () => api('/api/accounts').catch(() => ({ accounts: [] }));
const getModels = () => api('/api/models').catch(() => ({ data: [] }));
const getSessions = () => api('/api/sessions').catch(() => ({ sessions: [] }));
const getProxies = () => api('/api/proxies').catch(() => ({ proxies: [] }));
const getQuota = () => api('/api/quota').catch(() => null);

// ---------------------------------------------------------------- nav

function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${name}`)?.classList.add('active');
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  const titles = { overview: 'Overview', quota: 'Quota', playground: 'Playground', models: 'Models', sessions: 'Sessions', proxies: 'Proxies', accounts: 'Accounts', settings: 'Settings' };
  $('#view-title').textContent = titles[name] || 'Overview';
  if (name === 'settings') loadSettings();
  if (name === 'quota') renderQuota();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
$$('.link-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.jump)));

// ---------------------------------------------------------------- badges

const STATE_CLASS = {
  ok: 'ok', active: 'ok', ready: 'ok',
  banned: 'err', country_blocked: 'err', token_invalid: 'err', blocked: 'err',
  rate_limited: 'warn', model_locked: 'warn', ip_capped: 'warn',
  unknown: 'neutral', cooldown: 'info', expiring: 'warn', expired: 'neutral',
};
const STATE_LABEL = {
  ok: 'ok', active: 'active', ready: 'ready',
  banned: 'banned', country_blocked: 'blocked', token_invalid: 'invalid', blocked: 'blocked',
  rate_limited: 'ratelimit', model_locked: 'model lock', ip_capped: 'ip capped',
  unknown: 'unknown', cooldown: 'cooling', expiring: 'expiring', expired: 'expired',
};
function pill(state, extraLabel) {
  const cls = STATE_CLASS[state] || 'neutral';
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(extraLabel || STATE_LABEL[state] || state)}</span>`;
}
function fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}
function fmtPacific(iso) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Los_Angeles' }); }
  catch { return fmtClock(iso); }
}
function proxyHost(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || (u.protocol === 'socks5:' ? 1080 : 80)}`; }
  catch { return url; }
}

// ---------------------------------------------------------------- overview

async function renderOverview() {
  const [status, accounts, proxies] = await Promise.all([getStatus(), getAccounts(), getProxies()]);
  if (!status) { $('#stats-grid').innerHTML = '<div class="empty">cannot reach server</div>'; return; }
  $('#engine-chip').textContent = status.engine || '—';
  const stats = [
    { label: 'accounts', value: status.accounts.total, sub: `${status.accounts.alive} alive` },
    { label: 'proxies', value: status.proxies.total, sub: `${status.proxies.ready} ready` },
    { label: 'sessions', value: status.sessions, sub: 'active' },
    { label: 'models', value: status.models, sub: 'registered' },
    { label: 'uptime', value: fmtUptime(status.uptime), sub: '' },
  ];
  $('#stats-grid').innerHTML = stats.map((s) => `<div class="stat-card"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value} <small>${s.sub}</small></div></div>`).join('');
  $('#overview-accounts').innerHTML = accounts.accounts.length
    ? accounts.accounts.slice(0, 5).map((a) => `<div class="mini-row"><span class="k">${esc(a.token)}</span>${pill(a.state)}</div>`).join('')
    : '<div class="empty">no accounts</div>';
  $('#overview-proxies').innerHTML = proxies.proxies.length
    ? proxies.proxies.slice(0, 5).map((p) => `<div class="mini-row"><span class="k mono">${esc(p.host)}:${p.port}</span>${pill(p.state)}</div>`).join('')
    : '<div class="empty">no proxies — direct connection</div>';

  const dot = $('#sidebar-status-dot');
  const txt = $('#sidebar-status-text');
  dot.className = 'led';
  if (status.accounts.total === 0) txt.textContent = 'no accounts';
  else if (status.accounts.alive === 0) { dot.classList.add('err'); txt.textContent = 'accounts down'; }
  else if (status.accounts.unhealthy > 0 || status.accounts.unknown > 0) { dot.classList.add('warn'); txt.textContent = 'degraded'; }
  else { dot.classList.add('ok'); txt.textContent = `${status.accounts.alive}/${status.accounts.total} healthy`; }
}
function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

// ---------------------------------------------------------------- quota

function quotaCell(entry, glmPromo) {
  if ((!entry || entry.limit == null) && !glmPromo) return '<td class="mono dim">—</td>';
  let limit, used;
  if (entry && entry.limit > 0) { limit = entry.limit; used = entry.recentCount || 0; }
  else if (glmPromo && glmPromo.dailySessions > 0) { limit = glmPromo.dailySessions; used = entry?.recentCount || 0; }
  else return '<td class="mono dim">—</td>';
  const left = Math.max(0, Math.floor(limit - used));
  const cls = left <= 0 ? 'err' : left <= 2 ? 'warn' : 'ok';
  return `<td class="mono ${cls}">${left}/${limit}</td>`;
}

async function renderQuota(force = false) {
  const card = $('#view-quota .card');
  const table = $('#quota-table');
  table.innerHTML = '<div class="empty">scanning…</div>';
  let data;
  if (force) data = await api('/api/quota/refresh').catch(() => null);
  else data = await getQuota();
  if (!data) { table.innerHTML = '<div class="empty">quota scan failed</div>'; return; }
  state.quota = data;
  $('#quota-scanned').textContent = `scanned ${new Date().toLocaleTimeString('en-GB')}`;

  const models = data.models;
  const head = `<thead><tr><th>account</th><th>state</th><th>tier</th><th>session</th>${models.map((m) => `<th>${esc(m.split('/').pop())}</th>`).join('')}</tr></thead>`;
  const rows = data.accounts.map((a) => {
    const name = esc((a.uid || a.token || '').slice(0, 10));
    const tierCls = a.tier === 'limited' ? 'warn' : a.tier ? 'ok' : 'neutral';
    const glmPromo = a.glmPromo && a.glmPromo.dailySessions > 0 ? a.glmPromo : null;
    return `<tr>
      <td class="mono">${name}</td>
      <td>${pill(a.state)}</td>
      <td><span class="pill ${tierCls}"><span class="dot"></span>${esc(a.tier || '?')}</span></td>
      <td class="mono dim">${a.active ? fmtClock(a.expiresAt) : '—'}</td>
      ${models.map((m) => quotaCell(a.rateLimits[m], m === 'z-ai/glm-5.2' ? glmPromo : null)).join('')}
    </tr>`;
  }).join('');
  table.innerHTML = head + `<tbody>${rows}</tbody>`;

  const reset = data.accounts.map((a) => a.resetAt).find(Boolean);
  const glm = data.accounts.map((a) => a.glmPromo).find((g) => g && g.dailySessions > 0);
  const notes = [];
  if (reset) notes.push(`reset (Pacific) ${fmtPacific(reset)}`);
  if (glm) notes.push(`glm promo ${glm.dailySessions}/day until ${fmtClock(glm.endsAt)}`);
  let noteEl = card.querySelector('.quota-note');
  if (notes.length) {
    if (!noteEl) { noteEl = document.createElement('div'); noteEl.className = 'quota-note muted'; card.appendChild(noteEl); }
    noteEl.textContent = notes.join(' · ');
  } else if (noteEl) noteEl.remove();
}

// ---------------------------------------------------------------- models

async function renderModels() {
  const { data } = await getModels();
  state.models = data || [];
  $('#models-count').textContent = `${state.models.length} models`;
  $('#models-table').innerHTML = state.models.map((m) =>
    `<tr><td class="mono">${esc(m.id)}</td><td class="mono">${esc(m.agent || '—')}</td><td class="mono">${esc(m.upstream || '—')}</td><td>${esc(m.owned_by)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">no models</td></tr>';
  const sel = $('#chat-model');
  if (sel && sel.options.length <= 1) {
    sel.innerHTML = state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
  }
}

// ---------------------------------------------------------------- sessions

async function renderSessions() {
  const { sessions } = await getSessions();
  const dedup = new Map();
  for (const s of sessions) if (!dedup.has(s.instanceId)) dedup.set(s.instanceId, s);
  const rows = [...dedup.values()];
  $('#sessions-table').innerHTML = rows.map((s) => `
    <tr>
      <td class="mono">${esc(s.token)}</td>
      <td class="mono">${esc(s.model)}</td>
      <td class="mono">${s.remainingMs != null ? fmtDur(s.remainingMs) : '—'}</td>
      <td class="mono">${s.expiresAt ? fmtClock(s.expiresAt) : '—'}</td>
      <td>${s.usable ? pill('active') : (s.remainingMs != null && s.remainingMs <= 0 ? pill('expired') : pill('expiring'))}</td>
      <td><button class="btn btn-sm btn-danger" data-del-session="${esc(s.key)}">del</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">no active sessions</td></tr>';
  $$('#sessions-table [data-del-session]').forEach((b) => b.addEventListener('click', async () => {
    const [token, model] = b.dataset.delSession.split(':');
    await api('/api/session', { method: 'DELETE', body: JSON.stringify({ token, model }) });
    logActivity(`session deleted: ${model}`);
    await renderSessions();
  }));
}
async function purgeSessions() {
  confirmModal('purge sessions', 'delete all active sessions?', async () => {
    const r = await api('/api/sessions', { method: 'DELETE' });
    logActivity(`purged ${r.purged} sessions`);
    await renderSessions();
  });
}

// ---------------------------------------------------------------- proxies

async function renderProxies() {
  const { proxies } = await getProxies();
  state.proxies = proxies;
  $('#proxies-table').innerHTML = proxies.map((p) => `
    <tr>
      <td class="mono">${esc(p.url)}</td>
      <td><span class="pill neutral"><span class="dot"></span>${esc(p.protocol)}</span></td>
      <td>${pill(p.state)}</td>
      <td class="mono">${p.fails}</td>
      <td class="mono">${p.latencyMs != null ? p.latencyMs + 'ms' : '—'}</td>
      <td class="mono dim">${p.lastUsed ? fmtClock(p.lastUsed) : '—'}</td>
      <td class="row-actions"><button class="kebab" data-proxy-menu="${esc(p.url)}" title="actions">⋯</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">no proxies — direct connection</td></tr>';
  $$('#proxies-table [data-proxy-menu]').forEach((b) => b.addEventListener('click', () => {
    const url = b.dataset.proxyMenu;
    toggleMenu(b, [
      { label: 'test', fn: () => testProxy(url) },
      { label: 'remove', danger: true, fn: () => confirmModal('remove proxy', `${url}?`, async () => {
        await api('/api/proxy', { method: 'DELETE', body: JSON.stringify({ url }) });
        logActivity('proxy removed');
        await renderProxies();
      }) },
    ]);
  }));
}
async function testProxy(url) {
  logActivity(`testing proxy ${url}…`);
  try {
    const r = await api('/api/proxy/test', { method: 'POST', body: JSON.stringify({ url }) });
    logActivity(r.ok ? `proxy ${url} ok · ${r.latencyMs}ms` : `proxy ${url} failed · ${r.error}`, r.ok ? 'info' : 'err');
  } catch (e) { logActivity(`proxy test error: ${e.message}`, 'err'); }
  await renderProxies();
}

let proxyRefreshTimer = null;
function startProxyAutoRefresh() {
  stopProxyAutoRefresh();
  proxyRefreshTimer = setInterval(async () => { try { await renderProxies(); } catch {} }, 10000);
}
function stopProxyAutoRefresh() {
  if (proxyRefreshTimer) { clearInterval(proxyRefreshTimer); proxyRefreshTimer = null; }
}

// ---------------------------------------------------------------- accounts

async function renderAccounts() {
  const { accounts } = await getAccounts();
  state.accounts = accounts;
  state.bannedCount = accounts.filter((a) => a.state === 'banned').length;
  $('#accounts-count').textContent = `${accounts.length} accounts`;
  $('#accounts-table').innerHTML = accounts.map((a) => {
    const cooling = a.cooldownUntil && a.cooldownUntil > Date.now();
    const cooldownCell = cooling ? pill('cooldown', fmtDur(a.cooldownUntil - Date.now())) : '<span class="muted">—</span>';
    const proxyCell = a.boundProxy
      ? `<span class="pill info" title="${esc(a.boundProxy)}"><span class="dot"></span>${esc(proxyHost(a.boundProxy))}</span>`
      : '<span class="muted">auto</span>';
    return `<tr class="${a.active ? '' : 'row-inactive'}">
      <td><input type="checkbox" class="acct-chk" data-slot="${a.slot}" /></td>
      <td class="mono dim">#${a.slot}</td>
      <td class="mono">${esc(a.token)}</td>
      <td>${pill(a.state)}${a.manualState ? ` <span class="pill info"><span class="dot"></span>manual</span>` : ''}</td>
      <td>${cooldownCell}</td>
      <td>${proxyCell}</td>
      <td class="row-actions"><button class="kebab" data-acct-menu="${a.slot}" title="actions">⋯</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">no accounts — add tokens in settings</td></tr>';

  $$('#accounts-table [data-acct-menu]').forEach((b) => b.addEventListener('click', () => {
    const slot = Number(b.dataset.acctMenu);
    const a = state.accounts.find((x) => x.slot === slot);
    if (!a) return;
    toggleMenu(b, [
      { label: a.active ? 'deactivate' : 'activate', fn: () => setAccountActive(slot, !a.active) },
      { label: 'cooldown 5 min', fn: () => cooldownAccount(slot) },
      { label: 'mark rate-limited', fn: () => setAccountState(slot, 'rate_limited') },
      { label: 'bind proxy…', fn: () => bindProxyModal(slot) },
      '-',
      { label: 'ban', danger: true, fn: () => banAccount(slot) },
      { label: 'remove', danger: true, fn: () => removeAccount(slot) },
    ]);
  }));
}

async function setAccountActive(slot, active) {
  await api('/api/account/active', { method: 'POST', body: JSON.stringify({ slot, active }) });
  logActivity(`account #${slot} ${active ? 'activated' : 'deactivated'}`);
  await renderAccounts();
}
async function cooldownAccount(slot) {
  await api('/api/account/cooldown', { method: 'POST', body: JSON.stringify({ slot, ms: 5 * 60 * 1000 }) });
  logActivity(`account #${slot} cooled 5m`);
  await renderAccounts();
}
async function setAccountState(slot, newState) {
  await api('/api/account/state', { method: 'POST', body: JSON.stringify({ slot, state: newState }) });
  logActivity(`account #${slot} marked ${newState}`);
  await renderAccounts();
}
function banAccount(slot) {
  confirmModal('ban account', `slot #${slot}?`, async () => {
    await api('/api/account/state', { method: 'POST', body: JSON.stringify({ slot, state: 'banned' }) });
    logActivity(`account #${slot} banned`);
    await renderAccounts();
  });
}
function removeAccount(slot) {
  confirmModal('remove account', `slot #${slot}?`, async () => {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify({ slot }) });
    logActivity(`account #${slot} removed`);
    await refreshAll();
  });
}

function bindProxyModal(slot) {
  const proxies = state.proxies.map((p) => `<button class="btn btn-sm" data-bind-url="${esc(p.url)}">${esc(p.host)}:${p.port}</button>`).join('') || '<span class="muted">no proxies</span>';
  showModal(`bind proxy → account #${slot}`,
    `<p class="muted">pin this account to a proxy (or clear for auto-rotation):</p><div class="modal-proxy-list">${proxies}</div>`,
    `<button class="btn" id="modal-clear">clear (auto)</button><button class="btn" id="modal-cancel">cancel</button>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-clear').addEventListener('click', async () => { closeModal(); await bindProxy(slot, ''); });
  $$('#modal-box [data-bind-url]').forEach((b) => b.addEventListener('click', async () => { closeModal(); await bindProxy(slot, b.dataset.bindUrl); }));
}
async function bindProxy(slot, proxy) {
  const r = await api('/api/account/proxy', { method: 'POST', body: JSON.stringify({ slot, proxy }) });
  logActivity(`account #${slot} proxy ${proxy ? '→ ' + proxy : 'cleared'} (${r.bindings.length} bindings)`);
  await renderAccounts();
}

async function startOAuthLogin() {
  let info;
  try {
    info = await api('/api/auth/cli/code', { method: 'POST' });
  } catch (e) {
    showModal('oauth login', `<p class="muted">${esc('start failed: ' + e.message)}</p>`, `<button class="btn" id="modal-cancel">close</button>`);
    $('#modal-cancel').addEventListener('click', closeModal);
    return;
  }
  showModal('oauth login',
    `<p class="muted">Open this URL in a browser and authorize GitHub:</p>
     <div class="endpoint-box"><code id="oauth-url">${esc(info.loginUrl)}</code></div>
     <p class="muted" style="margin-top:10px">status: <span id="oauth-status" class="pill warn">waiting for authorization…</span></p>`,
    `<button class="btn" id="modal-cancel">close</button><button class="btn btn-primary" id="oauth-poll">check status</button>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#oauth-poll').addEventListener('click', async () => {
    const btn = $('#oauth-poll');
    btn.disabled = true;
    try {
      const qs = new URLSearchParams({ fingerprintId: info.fingerprintId, fingerprintHash: info.fingerprintHash || '', expiresAt: String(info.expiresAt || 0) });
      const st = await api('/api/auth/cli/status?' + qs.toString());
      if (st.status === 'ready') {
        $('#oauth-status').className = 'pill ok'; $('#oauth-status').textContent = 'authorized ✓ account added';
        logActivity('oauth account added');
        closeModal();
        await refreshAll();
      } else {
        $('#oauth-status').textContent = 'still pending — authorize the URL first';
      }
    } catch (e) {
      $('#oauth-status').className = 'pill err'; $('#oauth-status').textContent = 'error: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const cfg = await api('/api/config').catch(() => ({}));
  $('#cfg-apikey').value = apiKey();
  $('#endpoint-url').textContent = `${location.origin}/v1`;
  $('#endpoint-url-ant').textContent = `${location.origin}/v1`;
  if (cfg.tokens) $('#cfg-tokens').value = cfg.tokens.join('\n');
  if (cfg.proxies) $('#cfg-proxies').value = cfg.proxies.join('\n');
  $('#cfg-debug').checked = !!cfg.debug;
  $('#cfg-rotation').checked = cfg.rotation === 'roundrobin';
  $('#cfg-session-rotate').value = cfg.sessionRotateEvery ?? 0;
  $('#cfg-stealth').checked = !!cfg.tlsStealth;
  $('#cfg-tlsprofile').value = cfg.tlsProfile || 'chrome';
  $('#cfg-nodirect').checked = !!cfg.noDirect;
  $('#cfg-acct-rpm').value = cfg.acctRpm ?? 60;
  $('#cfg-global-rpm').value = cfg.globalRpm ?? 300;
  $('#cfg-affinity').value = cfg.affinityMaxUses ?? 3;
  $('#cfg-cooldown-base').value = cfg.cooldownBaseMs ?? 30000;
  $('#cfg-cooldown-cap').value = cfg.cooldownCapMs ?? 1800000;
}
async function saveSettings() {
  const tokens = $('#cfg-tokens').value.split(/\n/).map((t) => t.trim()).filter(Boolean);
  const proxies = $('#cfg-proxies').value.split(/\n/).map((p) => p.trim()).filter(Boolean);
  const key = $('#cfg-apikey').value.trim();
  if (key) localStorage.setItem('freebuffApiKey', key);
  const body = {
    tokens,
    proxies,
    debug: $('#cfg-debug').checked,
    rotation: $('#cfg-rotation').checked ? 'roundrobin' : 'pin',
    sessionRotateEvery: parseInt($('#cfg-session-rotate').value, 10) || 0,
    tlsStealth: $('#cfg-stealth').checked,
    tlsProfile: $('#cfg-tlsprofile').value.trim() || 'chrome',
    noDirect: $('#cfg-nodirect').checked,
    acctRpm: parseInt($('#cfg-acct-rpm').value, 10) || 60,
    globalRpm: parseInt($('#cfg-global-rpm').value, 10) || 300,
    affinityMaxUses: parseInt($('#cfg-affinity').value, 10) || 0,
    cooldownBaseMs: parseInt($('#cfg-cooldown-base').value, 10) || 0,
    cooldownCapMs: parseInt($('#cfg-cooldown-cap').value, 10) || 0,
  };
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    $('#cfg-status').textContent = `saved · ${r.accounts} accounts, ${r.proxies} proxies · rotation ${r.rotation} · stealth ${r.tlsStealth ? 'on' : 'off'}`;
    logActivity(`config saved: ${r.accounts} accounts, ${r.proxies} proxies, stealth ${r.tlsStealth ? 'on' : 'off'}`);
  } catch (e) { $('#cfg-status').textContent = `error: ${e.message}`; logActivity(`config save failed: ${e.message}`, 'err'); }
}

// ---------------------------------------------------------------- modal

function showModal(title, bodyHTML, actionsHTML) {
  $('#modal-box').innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" id="modal-close">✕</button></div>
    <div class="modal-body">${bodyHTML}</div>
    <div class="modal-actions">${actionsHTML}</div>`;
  $('#modal-overlay').hidden = false;
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
}
function closeModal() { $('#modal-overlay').hidden = true; $('#modal-box').innerHTML = ''; }
function confirmModal(title, msg, onConfirm) {
  showModal(title, `<p class="muted">${esc(msg)}</p>`,
    `<button class="btn" id="modal-cancel">cancel</button><button class="btn btn-primary" id="modal-ok">confirm</button>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', async () => { closeModal(); await onConfirm(); });
}
function inputModal(title, placeholder, onConfirm) {
  showModal(title, `<input id="modal-input" class="input-sm" style="width:100%" placeholder="${esc(placeholder)}" />`,
    `<button class="btn" id="modal-cancel">cancel</button><button class="btn btn-primary" id="modal-ok">add</button>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', async () => { const v = $('#modal-input').value.trim(); closeModal(); if (v) await onConfirm(v); });
  $('#modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modal-ok').click(); });
  setTimeout(() => $('#modal-input').focus(), 50);
}

// ---------------------------------------------------------------- playground

let chatHistory = [];
// Markdown-lite renderer (code blocks, inline code, bold, headings) — safe, escapes first.
function md(text) {
  let s = esc(text);
  // Protect fenced + inline code with placeholders so later transforms
  // (especially \n -> <br>) never corrupt code content.
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, c) => {
    blocks.push(`<pre><code>${c.replace(/^\n+|\n+$/g, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    blocks.push(`<code>${c}</code>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/^#{1,3}\s+(.+)$/gm, '<strong>$1</strong>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i] || '');
}
function addMessage(role, text, modelLabel) {
  const el = $('#chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const ts = new Date().toLocaleTimeString('en-GB');
  div.innerHTML = `<div class="avatar">${role === 'user' ? 'U' : 'A'}</div>
    <div class="bubble">
      <div class="role">${role}${role === 'assistant' && modelLabel ? ' · ' + esc(modelLabel) : ''}<span class="msg-ts">${ts}</span></div>
      <div class="reasoning" hidden></div>
      <div class="content">${esc(text)}</div>
    </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return { content: div.querySelector('.content'), reasoning: div.querySelector('.reasoning') };
}

function refreshAccountSelect() {
  const sel = $('#chat-account');
  const cur = sel.value;
  sel.innerHTML = '<option value="">auto (rotate)</option>' + state.accounts.map((a) =>
    `<option value="${a.slot}">#${a.slot} ${esc(a.token)}</option>`).join('');
  if (cur) sel.value = cur;
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  const model = $('#chat-model').value;
  const stream = $('#chat-stream').checked;
  const pinSlot = $('#chat-account').value;
  const newSession = $('#chat-new-session').checked;
  const roundRobin = $('#chat-roundrobin').checked;
  input.value = '';
  addMessage('user', text);
  chatHistory.push({ role: 'user', content: text });

  const body = { model, stream, messages: [{ role: 'system', content: $('#chat-system').value || 'You are a helpful assistant.' }, ...chatHistory] };
  const headers = { ...apiHeaders() };
  if (pinSlot) headers['x-freebuff-pin-slot'] = pinSlot;
  if (newSession) headers['x-freebuff-new-session'] = '1';
  if (roundRobin) headers['x-freebuff-rotation'] = 'roundrobin';

  const { content: contentEl, reasoning: reasoningEl } = addMessage('assistant', '', model);
  contentEl.classList.add('cursor-blink');

  try {
    if (stream) {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok || !res.body) throw new Error((await res.text()).slice(0, 200));
      let full = '', reasoningFull = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta || {};
            const rd = d.reasoning_content || '';
            const dc = d.content || '';
            if (rd) { reasoningFull += rd; reasoningEl.hidden = false; reasoningEl.textContent = reasoningFull; }
            if (dc) { full += dc; contentEl.innerHTML = md(full); }
            $('#chat-messages').scrollTop = 1e9;
          } catch {}
        }
      }
      contentEl.innerHTML = md(full) || '(no output)';
      if (reasoningFull) { reasoningEl.hidden = false; reasoningEl.textContent = reasoningFull; }
      chatHistory.push({ role: 'assistant', content: full });
    } else {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
      const full = data.choices?.[0]?.message?.content || '';
      const reasoning = data.choices?.[0]?.message?.reasoning_content || '';
      contentEl.innerHTML = md(full);
      if (reasoning) { reasoningEl.hidden = false; reasoningEl.textContent = reasoning; }
      chatHistory.push({ role: 'assistant', content: full });
    }
    logActivity(`chat: ${model}${pinSlot ? ' #' + pinSlot : ''} → ${stream ? 'stream' : 'sync'}`);
  } catch (e) {
    contentEl.textContent = `Error: ${e.message}`;
    contentEl.style.color = 'var(--red)';
    logActivity(`chat error: ${e.message}`, 'err');
  } finally {
    contentEl.classList.remove('cursor-blink');
  }
}

// ---------------------------------------------------------------- bootstrap

function wireEvents() {
  $('#refresh-btn').addEventListener('click', refreshAll);
  $('#quota-scan').addEventListener('click', () => renderQuota(true));
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $('#session-create').addEventListener('click', () => {
    const token = $('#session-token').value.trim();
    const model = $('#session-model').value.trim();
    if (token && model) api('/api/session', { method: 'POST', body: JSON.stringify({ token, model }) }).then(() => { logActivity(`session created: ${model}`); return renderSessions(); }).catch((e) => logActivity(`session create failed: ${e.message}`, 'err'));
  });
  $('#session-purge').addEventListener('click', purgeSessions);
  $('#proxy-add').addEventListener('click', () => inputModal('add proxy', 'http://host:port or socks5h://user:pass@host:port', async (url) => {
    await api('/api/proxy', { method: 'POST', body: JSON.stringify({ url }) });
    logActivity(`proxy added: ${url}`);
    await renderProxies();
  }));
  $('#proxy-rotate').addEventListener('click', async () => {
    await api('/api/proxy/rotate', { method: 'POST', body: '{}' });
    logActivity('proxy rotation advanced');
    await renderProxies();
  });
  $('#account-add-btn').addEventListener('click', () => inputModal('add account', 'authToken or authToken:uid', async (token) => {
    await api('/api/account', { method: 'POST', body: JSON.stringify({ token }) });
    logActivity(`account added`);
    await renderAccounts();
  }));
  $('#account-oauth-btn').addEventListener('click', startOAuthLogin);
  $('#account-menu-btn').addEventListener('click', () => {
    const items = [
      { label: 'rotate accounts', fn: async () => {
        await api('/api/account/rotate', { method: 'POST', body: '{}' });
        logActivity('account rotation advanced');
        await refreshAll();
      } },
      { label: 'auto-bind proxies', fn: async () => {
        const r = await api('/api/account/auto-proxy', { method: 'POST', body: '{}' });
        logActivity(`auto proxy: ${r.assigned} accounts bound across ${r.proxies} proxies`);
        await renderAccounts();
      } },
    ];
    if (state.bannedCount > 0) items.push('-', { label: `delete banned (${state.bannedCount})`, danger: true, fn: () => confirmModal('delete banned', 'remove all banned accounts?', async () => {
      const r = await api('/api/account/delete-banned', { method: 'POST', body: '{}' });
      logActivity(`deleted ${r.removed} banned accounts`);
      await refreshAll();
    }) });
    toggleMenu($('#account-menu-btn'), items);
  });
  $('#accounts-select-all').addEventListener('change', (e) => {
    $$('#accounts-table .acct-chk').forEach((c) => { c.checked = e.target.checked; });
  });
  $('#proxy-auto-refresh').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ proxyAutoRefresh: on }) });
      logActivity(`proxy auto-refresh ${on ? 'enabled' : 'disabled'}`);
      if (on) startProxyAutoRefresh(); else stopProxyAutoRefresh();
    } catch (err) { logActivity(`proxy auto-refresh toggle failed: ${err.message}`, 'err'); e.target.checked = !on; }
  });
  $('#cfg-save').addEventListener('click', saveSettings);
}

async function refreshAll() {
  const [accts, proxies] = await Promise.all([getAccounts(), getProxies()]);
  state.accounts = accts.accounts || [];
  state.proxies = proxies.proxies || [];
  refreshAccountSelect();
  await Promise.all([renderOverview(), renderModels(), renderSessions(), renderProxies(), renderAccounts()]);
}

// API key login gate — require the key before showing the dashboard.
function setupLoginGate() {
  const overlay = $('#login-overlay');
  const key = localStorage.getItem('freebuffApiKey');
  if (key) { overlay.hidden = true; return; }
  overlay.hidden = false;
  $('#login-key').value = DEFAULT_KEY;
  const submit = async () => {
    const v = $('#login-key').value.trim();
    if (!v) return;
    localStorage.setItem('freebuffApiKey', v);
    overlay.hidden = true;
    await refreshAll();
    logActivity('dashboard unlocked');
  };
  $('#login-submit').addEventListener('click', submit);
  $('#login-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

async function boot() {
  wireEvents();
  setupLoginGate();
  await refreshAll();
  // Init proxy auto-refresh toggle from config.
  try {
    const cfg = await api('/api/config').catch(() => ({}));
    const t = $('#proxy-auto-refresh');
    if (t) { t.checked = !!cfg.proxyAutoRefresh; if (cfg.proxyAutoRefresh) startProxyAutoRefresh(); }
  } catch {}
  setInterval(() => { renderOverview().catch(() => {}); }, 10000);
  logActivity('dashboard connected');
}
boot();
