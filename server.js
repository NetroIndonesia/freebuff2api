// server.js — freebuff2api self-hosted server
// Exposes the freebuff/codebuff free models as OpenAI / Anthropic compatible APIs,
// with rotating proxy pools, session/model management and a live dashboard.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as baseFetch } from 'undici';
import { ProxyPool, makeProxyConnector, parseProxy } from './proxy.js';
import * as store from './store.js';
import { stealthFetch, StealthUnavailableError, setStealthEnabled, setStealthProfile } from './stealth.js';

// Freebuff engine: OpenAI/Anthropic-compatible routes + session/model lifecycle.
const { default: handler, internals } = await import('./engine.js');
const { scanQuota } = await import('./quota.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_PATH = resolve(ROOT, 'data.db');
const CONFIG_PATH = resolve(ROOT, 'config.json');
const CRED_DIR = resolve(ROOT, 'credentials');
const PROXIES_FILE = resolve(ROOT, 'proxies.txt');
const PUBLIC_DIR = resolve(ROOT, 'public');
const DEFAULT_API_KEY = 'freebuff-default-key';

const startedAt = Date.now();

// ---------------------------------------------------------------- storage ----

store.initStore(DB_PATH);

// ---- legacy import helpers (config.json / credentials/ / proxies.txt) ----

function readTokenFiles() {
  const out = [];
  if (!existsSync(CRED_DIR)) return out;
  for (const f of readdirSync(CRED_DIR)) {
    try {
      const content = readFileSync(join(CRED_DIR, f), 'utf8');
      for (const tok of content.split(/[\n,]/)) {
        const t = tok.trim();
        if (t.length > 8) out.push(t);
      }
    } catch {}
  }
  return out;
}

function readProxyFile() {
  if (!existsSync(PROXIES_FILE)) return [];
  return readFileSync(PROXIES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5 && !s.startsWith('#'));
}

function splitEnv(value) {
  return (value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function uniq(arr) {
  return [...new Set(arr)];
}

function loadConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// Import legacy config.json / credentials / proxies.txt into SQLite on first run.
function migrateLegacy() {
  if (store.listAccounts().length > 0 || store.getSetting('apiKey')) return;
  const fileCfg = loadConfigFile();
  const tokens = uniq([
    ...(Array.isArray(fileCfg.tokens) ? fileCfg.tokens : []),
    ...readTokenFiles(),
    ...splitEnv(process.env.FREEBUFF_TOKEN),
  ]).filter((t) => t.length > 8);
  const proxies = uniq([
    ...(Array.isArray(fileCfg.proxies) ? fileCfg.proxies : []),
    ...readProxyFile(),
    ...splitEnv(process.env.PROXIES || process.env.HTTP_PROXY || process.env.HTTPS_PROXY),
  ]);
  for (const t of tokens) {
    const idx = t.indexOf(':');
    store.addAccount(idx > 0 ? t.slice(0, idx).trim() : t, idx > 0 ? t.slice(idx + 1).trim() || null : null);
  }
  store.setSetting('apiKey', process.env.FREEBUFF_API_KEY || process.env.API_KEY || fileCfg.apiKey || DEFAULT_API_KEY);
  store.setSetting('debug', String((process.env.FREEBUFF_DEBUG || fileCfg.debug || 'false') === 'true'));
  store.setSetting('rotation', (process.env.ROTATION_MODE || fileCfg.rotation || 'pin') === 'roundrobin' ? 'roundrobin' : 'pin');
  store.setSetting('sessionRotateEvery', String(Math.max(0, parseInt(process.env.SESSION_ROTATE_EVERY || fileCfg.sessionRotateEvery || '0', 10) || 0)));
  store.setSetting('proxies', JSON.stringify(proxies));
}

migrateLegacy();

// ---- working state (loaded from SQLite) ----

// Resolve a setting: explicit SQLite value first (set via the dashboard),
// then the matching env var, then the default. Empty SQLite string = unset.
function settingBool(key, envName, def) {
  const s = store.getSetting(key, '');
  if (s === 'true' || s === 'false') return s === 'true';
  if (process.env[envName] !== undefined) return ['1', 'true', 'yes'].includes(String(process.env[envName]).toLowerCase());
  return def;
}
function settingInt(key, envName, def) {
  const s = store.getSetting(key, '');
  if (s !== '') { const n = parseInt(s, 10); if (!Number.isNaN(n)) return n; }
  if (process.env[envName] !== undefined) { const n = parseInt(process.env[envName], 10); if (!Number.isNaN(n)) return n; }
  return def;
}
function settingStr(key, envName, def) {
  const s = store.getSetting(key, '');
  if (s !== '') return s;
  if (process.env[envName]) return process.env[envName];
  return def;
}

let state = {
  accounts: store.listAccounts(),   // { token, uid, active, proxy, state, addedAt }
  proxies: JSON.parse(store.getSetting('proxies', '[]') || '[]'),
  apiKey: store.getSetting('apiKey', DEFAULT_API_KEY),
  debug: store.getSetting('debug', 'false') === 'true',
  rotation: store.getSetting('rotation', 'pin'),
  sessionRotateEvery: parseInt(store.getSetting('sessionRotateEvery', '0'), 10) || 0,
  proxyAutoRefresh: store.getSetting('proxyAutoRefresh', 'false') === 'true',
  // TLS stealth + egress (dashboard-tunable, env fallback)
  tlsStealth: settingBool('tlsStealth', 'TLS_STEALTH', false),
  tlsProfile: settingStr('tlsProfile', 'TLS_PROFILE', 'chrome'),
  noDirect: settingBool('noDirect', 'FREEBUFF_NO_DIRECT', false),
  // Anti-ban tunables (engine.js reads these per request via the env getters)
  acctRpm: settingInt('acctRpm', 'FREEBUFF_ACCT_RPM', 60),
  globalRpm: settingInt('globalRpm', 'FREEBUFF_GLOBAL_RPM', 300),
  affinityMaxUses: settingInt('affinityMaxUses', 'FREEBUFF_AFFINITY_MAX_USES', 3),
  cooldownBaseMs: settingInt('cooldownBaseMs', 'FREEBUFF_COOLDOWN_BASE_MS', 30000),
  cooldownCapMs: settingInt('cooldownCapMs', 'FREEBUFF_COOLDOWN_CAP_MS', 1800000),
};

// Seed the stealth layer from the resolved state; re-called on config update.
// (stealth.js gates on its own mutable flag, so it must be synced here.)
function applyStealthState() {
  setStealthEnabled(state.tlsStealth);
  setStealthProfile(state.tlsProfile);
}
applyStealthState();
// Active accounts only — shown in settings/status. Banned accounts stay listed
// here so the operator can inspect/delete them, but are excluded from rotation.
function activeTokenList() {
  return state.accounts.filter((a) => a.active).map((a) => (a.uid ? `${a.token}:${a.uid}` : a.token));
}

// Terminal states that must never rotate: manual override or upstream-observed.
const TERMINAL_STATES = new Set(['banned', 'country_blocked', 'token_invalid']);
function isAccountBanned(a) {
  if (TERMINAL_STATES.has(a.state)) return true;
  return TERMINAL_STATES.has(internals.accountHealth()[a.token]?.state);
}

// Accounts the engine may rotate through: active and not banned.
function rotationTokenList() {
  return state.accounts
    .filter((a) => a.active && !isAccountBanned(a))
    .map((a) => (a.uid ? `${a.token}:${a.uid}` : a.token));
}
function persistSettings() {
  store.setSetting('apiKey', state.apiKey);
  store.setSetting('debug', String(state.debug));
  store.setSetting('rotation', state.rotation);
  store.setSetting('sessionRotateEvery', String(state.sessionRotateEvery));
  store.setSetting('proxyAutoRefresh', String(state.proxyAutoRefresh));
  store.setSetting('proxies', JSON.stringify(state.proxies));
  store.setSetting('tlsStealth', String(state.tlsStealth));
  store.setSetting('tlsProfile', state.tlsProfile);
  store.setSetting('noDirect', String(state.noDirect));
  store.setSetting('acctRpm', String(state.acctRpm));
  store.setSetting('globalRpm', String(state.globalRpm));
  store.setSetting('affinityMaxUses', String(state.affinityMaxUses));
  store.setSetting('cooldownBaseMs', String(state.cooldownBaseMs));
  store.setSetting('cooldownCapMs', String(state.cooldownCapMs));
}

function reloadAccounts() {
  const all = store.listAccounts();
  let order = [];
  try { order = JSON.parse(store.getSetting('accountOrder', '[]') || '[]'); } catch {}
  if (Array.isArray(order) && order.length) {
    const byToken = new Map(all.map((a) => [a.token, a]));
    state.accounts = order.map((t) => byToken.get(t)).filter(Boolean);
    for (const a of all) if (!state.accounts.some((x) => x.token === a.token)) state.accounts.push(a);
  } else {
    state.accounts = all;
  }
}

function persistAccountOrder() {
  store.setSetting('accountOrder', JSON.stringify(state.accounts.map((a) => a.token)));
}

function slotToken(slot) {
  const idx = Number.isInteger(slot) && slot >= 1 ? slot - 1 : -1;
  return state.accounts[idx]?.token || null;
}

const env = {
  get FREEBUFF_TOKEN() { return rotationTokenList().join(','); },
  get API_KEY() { return state.apiKey; },
  get FREEBUFF_API_KEY() { return state.apiKey; },
  get FREEBUFF_DEBUG() { return String(state.debug); },
  get ROTATION_MODE() { return state.rotation; },
  get SESSION_ROTATE_EVERY() { return String(state.sessionRotateEvery); },
  // Anti-ban tunables (dashboard-tunable; engine.js reads them per request).
  get FREEBUFF_ACCT_RPM() { return String(state.acctRpm); },
  get FREEBUFF_GLOBAL_RPM() { return String(state.globalRpm); },
  get FREEBUFF_AFFINITY_MAX_USES() { return String(state.affinityMaxUses); },
  get FREEBUFF_COOLDOWN_BASE_MS() { return String(state.cooldownBaseMs); },
  get FREEBUFF_COOLDOWN_CAP_MS() { return String(state.cooldownCapMs); },
};

// --------------------------------------------------------------- proxy pool --

const pool = new ProxyPool(state.proxies);
// Re-apply saved per-account proxy bindings to the pool.
for (const a of state.accounts) if (a.proxy) pool.setBinding(a.token, a.proxy);

// Retry is only safe when the request body can be replayed (worker upstream
// calls send JSON strings or nothing; streaming upload bodies are not replayed).
function isReplayableBody(body) {
  return body == null || typeof body === 'string' || Buffer.isBuffer(body) ||
    body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

// Route every outbound fetch through the rotating proxy pool, with a direct
// fallback on failure. engine.js calls the bare global fetch, so overriding it
// here wires proxy rotation into the engine with zero changes to the engine.
// Per-account binding: if the request carries `Authorization: Bearer <token>`
// and that token is pinned to a proxy, that proxy is used instead of rotation.
const nativeFetch = globalThis.fetch;

function tokenFromInit(init) {
  const h = init?.headers;
  let auth = null;
  if (h) {
    if (typeof h.get === 'function') auth = h.get('Authorization') || h.get('authorization');
    else if (typeof h === 'object') auth = h.Authorization || h.authorization;
  }
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// TLS stealth (optional): routes every upstream request through
// impers/libcurl-impersonate with a real browser TLS + HTTP/2 fingerprint
// (state.tlsProfile) instead of undici's OpenSSL-shaped ClientHello.
// engine.js/quota.js keep calling bare fetch — zero changes. Toggled live from
// the dashboard (state.tlsStealth); see stealth.js setStealthEnabled.
// Latched after a fatal stealth failure (libcurl missing/broken): the rest of
// the process falls back to the plain undici path.
let stealthDisabled = false;

// Direct (no-proxy) fetch honoring stealth mode, so the VPS egress IP is never
// paired with the OpenSSL fingerprint when stealth is on.
function directFetch(input, init) {
  if (state.tlsStealth && !stealthDisabled) return stealthFetch(input, init, {});
  return nativeFetch(input, init);
}

// Proxy-only mode (state.noDirect): never fall back to a direct connection
// when proxies fail, so the VPS egress IP is never exposed upstream (avoids
// ip_capped / IP linking across accounts).

globalThis.fetch = function proxiedFetch(input, init = {}) {
  const bound = pool.bindingDispatcher(tokenFromInit(init));
  const entry = bound || pool.next();
  if (!entry) {
    if (state.noDirect) return Promise.reject(new Error('no proxy available (FREEBUFF_NO_DIRECT=1)'));
    return directFetch(input, init);
  }

  const t0 = Date.now();
  const attempt = (e) => {
    if (state.tlsStealth && !stealthDisabled) return stealthFetch(input, init, { proxy: e.key });
    return nativeFetch(input, { ...init, dispatcher: e.dispatcher });
  };
  return attempt(entry).then(
    (res) => { pool.reportSuccess(entry.key, Date.now() - t0); return res; },
    (err) => {
      if (err instanceof StealthUnavailableError) {
        stealthDisabled = true;
        console.warn('[server] TLS stealth unavailable — falling back to plain fetch for the rest of this run');
      }
      pool.reportFailure(entry.key);
      if (!isReplayableBody(init.body)) throw err;
      // Fall back to auto-rotation (reportFailure already cooled the failed
      // proxy, so pool.next() skips it when others exist) or a direct connection.
      const next = pool.next();
      if (next) {
        const t1 = Date.now();
        return attempt(next).then(
          (res) => { pool.reportSuccess(next.key, Date.now() - t1); return res; },
          (err2) => {
            if (err2 instanceof StealthUnavailableError) {
              stealthDisabled = true;
              console.warn('[server] TLS stealth unavailable — falling back to plain fetch for the rest of this run');
            }
            pool.reportFailure(next.key);
            if (state.noDirect) throw err2;
            return directFetch(input, init);
          },
        );
      }
      if (state.noDirect) throw err;
      return directFetch(input, init);
    },
  );
};

// ---------------------------------------------------------------- helpers ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function mask(token) {
  if (!token) return null;
  return token.length <= 10 ? token : `${token.slice(0, 6)}…${token.slice(-3)}`;
}

function getApiKey(request) {
  const expected = state.apiKey;
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7) === expected ? expected : null;
  return request.headers.get('x-api-key') === expected ? expected : null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ------------------------------------------------------- management endpoints -

async function handleStatus(res) {
  const health = internals.accountHealth();
  const accountStates = {};
  let alive = 0, unhealthy = 0, unknown = 0, inactive = 0;
  for (const a of state.accounts) {
    const h = health[a.token];
    if (!a.active) { inactive++; continue; }
    const s = a.state && a.state !== 'unknown' ? a.state : (h?.state || 'unknown');
    accountStates[s] = (accountStates[s] || 0) + 1;
    if (s === 'banned' || s === 'rate_limited') unhealthy++;
    else if (h?.alive === true) alive++;
    else if (h?.alive === false) unhealthy++;
    else unknown++;
  }
  const proxies = pool.list();
  const sessions = internals.sessions();
  const models = internals.modelTableCached();
  json(res, {
    service: 'freebuff2api',
    version: '2.0.0',
    engine: internals.version,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    accounts: { total: state.accounts.length, active: state.accounts.length - inactive, inactive, alive, unhealthy, unknown, states: accountStates },
    proxies: { total: proxies.length, ready: proxies.filter((p) => p.state === 'ready').length },
    sessions: sessions.length,
    models: models.length,
    quota: quotaSnapshot ? { scannedAt: quotaSnapshot.scannedAt } : null,
    cache: { sessions: sessions.length, accountsObserved: Object.keys(health).length },
    time: new Date().toISOString(),
  });
}

function handleAccounts(res) {
  const health = internals.accountHealth();
  const cooldowns = internals.cooldowns();
  json(res, {
    accounts: state.accounts.map((a, i) => {
      const h = health[a.token];
      const effState = a.state || h?.state || 'unknown';
      return {
        slot: i + 1,
        token: mask(a.token),
        uid: (h?.uid || a.uid) ? mask(h?.uid || a.uid) : null,
        active: a.active,
        alive: h?.alive ?? null,
        state: effState,
        manualState: a.state || null,
        checkedAt: h?.checkedAt || null,
        cooldownUntil: cooldowns[a.token] || null,
        hasQuota: Boolean(h?.quota),
        boundProxy: a.proxy || null,
      };
    }),
  });
}

async function handleModels(res) {
  const models = await internals.modelTable().catch(() => []);
  json(res, {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      agent: m.agent,
      upstream: m.upstream,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'freebuff',
    })),
  });
}

function handleSessions(res) {
  const sessions = internals.sessions();
  const now = Date.now();
  json(res, {
    sessions: sessions.map((s) => {
      // Recompute remaining from expiresAt (cached remainingMs is frozen at
      // creation time, so it would keep showing "active" after expiry).
      const expMs = Date.parse(s.expiresAt || "");
      const remainingMs = Number.isFinite(expMs) ? Math.max(0, expMs - now) : (s.remainingMs ?? 0);
      const usable = Number.isFinite(expMs) ? expMs > now + 60000 : (typeof s.remainingMs === 'number' && s.remainingMs > 60000);
      return {
        key: s.key,
        token: mask(s.token),
        model: s.model,
        instanceId: s.instanceId,
        remainingMs,
        expiresAt: s.expiresAt,
        usable,
      };
    }),
  });
}

async function handleCreateSession(res, body) {
  const token = String(body.token || '').trim();
  const model = String(body.model || '').trim();
  if (!token || !model) return json(res, { ok: false, error: 'token and model required' }, 400);
  try {
    const session = await internals.createSession(token, model);
    json(res, { ok: true, session: { model: session.model, instanceId: session.instanceId, remainingMs: session.remainingMs } });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 502);
  }
}

async function handleDeleteSession(res, body) {
  const token = String(body.token || '').trim();
  const model = String(body.model || '').trim();
  if (!token || !model) return json(res, { ok: false, error: 'token and model required' }, 400);
  const deleted = await internals.deleteSession(token, model);
  json(res, { ok: true, deleted });
}

function canonProxy(url) {
  try { return parseProxy(String(url).trim()).key; } catch { return null; }
}

function handleProxies(res) {
  json(res, { proxies: pool.list() });
}

function handleAddProxy(res, body) {
  const key = canonProxy(body.url);
  if (!key) return json(res, { ok: false, error: 'invalid proxy URL' }, 400);
  const added = pool.add(key);
  if (added) {
    state.proxies = [...state.proxies, key];
    persistSettings();
  }
  json(res, { ok: added, error: added ? null : 'invalid or duplicate proxy URL' });
}

function handleRemoveProxy(res, body) {
  const key = canonProxy(body.url);
  if (!key) return json(res, { ok: false, error: 'invalid proxy URL' }, 400);
  const removed = pool.remove(key);
  if (removed) {
    state.proxies = state.proxies.filter((p) => canonProxy(p) !== key);
    persistSettings();
  }
  json(res, { ok: removed });
}

async function testProxy(url) {
  const key = canonProxy(url);
  if (!key) return { ok: false, error: 'invalid proxy URL' };
  const { Agent } = await import('undici');
  const agent = new Agent({ connect: makeProxyConnector(key), pipelining: 0 });
  try {
    const t0 = Date.now();
    const r = await baseFetch('https://www.codebuff.com/api/v1/me', {
      method: 'GET',
      dispatcher: agent,
      signal: AbortSignal.timeout(12000),
    });
    await r.text().catch(() => {});
    return { ok: true, latencyMs: Date.now() - t0, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    agent.destroy();
  }
}

async function handleTestProxy(res, body) {
  const url = String(body.url || '').trim();
  if (!url) return json(res, { ok: false, error: 'url required' }, 400);
  json(res, await testProxy(url));
}

// Background proxy health re-test: when enabled, periodically probes each proxy
// and updates pool cooldown/latency without touching the request path.
let proxyRefreshing = false;
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '60000', 10) || 60000;
async function refreshProxiesBackground() {
  if (!state.proxyAutoRefresh || proxyRefreshing || state.proxies.length === 0) return;
  proxyRefreshing = true;
  try {
    for (const p of state.proxies) {
      const key = canonProxy(p);
      if (!key) continue;
      const r = await testProxy(key);
      if (r.ok) pool.reportSuccess(key, r.latencyMs);
      else pool.reportFailure(key);
    }
  } catch {} finally {
    proxyRefreshing = false;
  }
}

// ---------------------------------------------------------------- accounts ----

function handleAddAccount(res, body) {
  let token = String(body.token || '').trim();
  let uid = body.uid || null;
  const idx = token.indexOf(':');
  if (idx > 0) { uid = uid || token.slice(idx + 1).trim() || null; token = token.slice(0, idx).trim(); }
  if (token.length <= 8) return json(res, { ok: false, error: 'invalid token' }, 400);
  store.addAccount(token, uid);
  reloadAccounts();
  refreshQuotaBackground();
  json(res, { ok: true, accounts: state.accounts.length });
}

function handleRemoveAccount(res, body) {
  const token = slotToken(Number(body.slot));
  if (!token) return json(res, { ok: false, error: 'bad slot' }, 400);
  store.removeAccount(token);
  pool.clearBinding(token);
  reloadAccounts();
  json(res, { ok: true, accounts: state.accounts.length });
}

function handleBulkRemoveAccounts(res, body) {
  const slots = Array.isArray(body.slots) ? body.slots.map(Number) : [];
  const tokens = slots.map(slotToken).filter(Boolean);
  for (const t of tokens) { store.removeAccount(t); pool.clearBinding(t); }
  reloadAccounts();
  json(res, { ok: true, removed: tokens.length });
}

function handleRemoveBannedAccounts(res) {
  const health = internals.accountHealth();
  const toRemove = state.accounts.filter((a) => a.state === 'banned' || health[a.token]?.state === 'banned');
  for (const a of toRemove) { store.removeAccount(a.token); pool.clearBinding(a.token); }
  reloadAccounts();
  json(res, { ok: true, removed: toRemove.length });
}

function handleCooldownAccount(res, body) {
  const token = slotToken(Number(body.slot));
  if (!token) return json(res, { ok: false, error: 'bad slot' }, 400);
  const ms = Math.min(Math.max(Number(body.ms) || 60 * 1000, 5000), 12 * 3600 * 1000);
  internals.cooldown(token, ms);
  json(res, { ok: true, slot: Number(body.slot), ms });
}

// Toggle active/inactive. Inactive accounts are excluded from engine rotation.
function handleSetAccountActive(res, body) {
  const token = slotToken(Number(body.slot));
  if (!token) return json(res, { ok: false, error: 'bad slot' }, 400);
  store.setAccountActive(token, !!body.active);
  reloadAccounts();
  json(res, { ok: true, active: !!body.active });
}

// Manual state override: 'banned' | 'rate_limited' | null (clear).
function handleSetAccountState(res, body) {
  const token = slotToken(Number(body.slot));
  if (!token) return json(res, { ok: false, error: 'bad slot' }, 400);
  const st = body.state === 'banned' || body.state === 'rate_limited' ? body.state : null;
  store.setAccountState(token, st);
  if (st === 'rate_limited') internals.cooldown(token, 10 * 60 * 1000);
  if (st === 'banned') internals.cooldown(token, 12 * 3600 * 1000);
  reloadAccounts();
  json(res, { ok: true, state: st });
}

function handleRotateAccount(res) {
  if (state.accounts.length < 2) return json(res, { ok: true, accounts: state.accounts.length });
  state.accounts.push(state.accounts.shift());
  persistAccountOrder();
  json(res, { ok: true, accounts: state.accounts.length });
}

function handleOrderAccount(res, body) {
  const slots = Array.isArray(body.slots) ? body.slots.map(Number) : [];
  if (slots.length !== state.accounts.length) return json(res, { ok: false, error: 'slots must match account count' }, 400);
  const seen = new Set(slots);
  if (seen.size !== slots.length || slots.some((s) => !Number.isInteger(s) || s < 1 || s > state.accounts.length)) {
    return json(res, { ok: false, error: 'invalid slot list' }, 400);
  }
  state.accounts = slots.map((s) => state.accounts[s - 1]);
  persistAccountOrder();
  json(res, { ok: true, order: state.accounts.map((a, i) => i + 1) });
}

// Bind a proxy to an account. Empty proxy clears the binding.
function handleAccountProxy(res, body) {
  const token = slotToken(Number(body.slot));
  if (!token) return json(res, { ok: false, error: 'bad slot' }, 400);
  const proxyUrl = String(body.proxy || '').trim();
  const ok = proxyUrl ? pool.setBinding(token, proxyUrl) : pool.clearBinding(token);
  if (ok || !proxyUrl) store.setAccountProxy(token, proxyUrl || null);
  reloadAccounts();
  json(res, { ok: ok || !proxyUrl, bindings: pool.listBindings() });
}

// Auto-assign proxies to active accounts round-robin (helper: no one-by-one).
function handleAutoApplyProxy(res) {
  const proxies = state.proxies;
  const active = state.accounts.filter((a) => a.active);
  let assigned = 0;
  active.forEach((a, i) => {
    if (!proxies.length) return;
    const proxy = proxies[i % proxies.length];
    if (pool.setBinding(a.token, proxy)) { store.setAccountProxy(a.token, proxy); assigned++; }
  });
  reloadAccounts();
  json(res, { ok: true, assigned, proxies: proxies.length });
}

function handleRotateProxy(res) {
  const idx = pool.rotate();
  json(res, { ok: true, idx });
}

function handlePurgeSessions(res) {
  const sessions = internals.sessions();
  const count = sessions.length;
  for (const s of sessions) {
    const [token] = s.key.split(':');
    internals.deleteSession(token, s.model);
  }
  json(res, { ok: true, purged: count });
}

function handleClearCache(res) {
  const sessions = internals.sessions();
  for (const s of sessions) {
    const [token] = s.key.split(':');
    internals.deleteSession(token, s.model);
  }
  json(res, { ok: true, cleared: sessions.length });
}

// ----------------------------------------------------------- oauth login ----

async function handleOAuthStart(res) {
  try {
    const info = await internals.startDeviceAuth();
    json(res, { ok: true, loginUrl: info.loginUrl, fingerprintId: info.fingerprintId, fingerprintHash: info.fingerprintHash, expiresAt: info.expiresAt });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 502);
  }
}

async function handleOAuthStatus(res, query) {
  const fpId = String(query.get('fingerprintId') || '').trim();
  const fpHash = String(query.get('fingerprintHash') || '').trim();
  const expiresAt = parseInt(query.get('expiresAt') || '0', 10) || 0;
  if (!fpId) return json(res, { ok: false, error: 'fingerprintId required' }, 400);
  try {
    const result = await internals.pollDeviceAuth(fpId, fpHash, expiresAt);
    let added = false;
    if (result.status === 'ready' && result.authToken && result.authToken.length > 8) {
      const idx = result.authToken.indexOf(':');
      const token = idx > 0 ? result.authToken.slice(0, idx).trim() : result.authToken;
      const uid = idx > 0 ? result.authToken.slice(idx + 1).trim() || result.uid || null : result.uid || null;
      store.addAccount(token, uid);
      reloadAccounts();
      refreshQuotaBackground();
      added = true;
    }
    json(res, { ok: true, status: result.status, added, uid: result.uid || null, email: result.email || null });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 502);
  }
}

// ---------------------------------------------------------------- quota ----

let quotaSnapshot = null;
let quotaScanning = false;
const QUOTA_REFRESH_MS = parseInt(process.env.QUOTA_REFRESH_MS || '300000', 10) || 300000;
try { quotaSnapshot = JSON.parse(store.getSetting('quotaSnapshot', 'null') || 'null'); } catch { quotaSnapshot = null; }

// Feed terminal account states (banned/country_blocked/token_invalid) from the
// quota scan into the engine's health map, so they are excluded from rotation
// immediately instead of each being hit with a live 403 first.
function seedTerminalFromSnapshot() {
  const accounts = quotaSnapshot?.data?.accounts;
  if (!Array.isArray(accounts)) return;
  let seeded = 0;
  for (const a of accounts) {
    if (TERMINAL_STATES.has(a.state)) {
      internals.seedHealth(a.token, a.state);
      seeded++;
    }
  }
  if (seeded) console.log(`[quota] seeded ${seeded} terminal account(s) from snapshot`);
}
seedTerminalFromSnapshot();
 
 async function refreshQuotaBackground() {
   if (quotaScanning) return;
   quotaScanning = true;
   try {
     const accounts = state.accounts.filter((a) => a.active).map((a) => ({ token: a.token, uid: a.uid }));
     if (!accounts.length) { quotaSnapshot = null; return; }
     const data = await scanQuota(accounts);
     quotaSnapshot = { data, scannedAt: Date.now() };
     store.setSetting('quotaSnapshot', JSON.stringify(quotaSnapshot));
    seedTerminalFromSnapshot();
    console.log(`[quota] background scan: ${accounts.length} accounts`);
  } catch (e) {
    console.error('[quota] background scan failed:', e.message);
  } finally {
    quotaScanning = false;
  }
}

function handleQuota(res) {
  if (quotaSnapshot) {
    json(res, { ...quotaSnapshot.data, scannedAt: quotaSnapshot.scannedAt });
  } else {
    // trigger a scan and report not-ready; the background task will populate it
    refreshQuotaBackground();
    json(res, { models: [], accounts: [], scanning: true, scannedAt: null });
  }
}

function handleConfig(res) {
  json(res, {
    tokens: activeTokenList(),
    apiKey: mask(state.apiKey),
    proxies: state.proxies,
    debug: state.debug,
    rotation: state.rotation,
    sessionRotateEvery: state.sessionRotateEvery,
    proxyAutoRefresh: state.proxyAutoRefresh,
    tlsStealth: state.tlsStealth,
    tlsProfile: state.tlsProfile,
    noDirect: state.noDirect,
    acctRpm: state.acctRpm,
    globalRpm: state.globalRpm,
    affinityMaxUses: state.affinityMaxUses,
    cooldownBaseMs: state.cooldownBaseMs,
    cooldownCapMs: state.cooldownCapMs,
  });
}

function handleUpdateConfig(res, body) {
  const isReal = (t) => typeof t === 'string' && t.trim().length > 8 && !t.includes('…');
  if (Array.isArray(body.tokens)) {
    const keep = new Set();
    for (const t of body.tokens) {
      const s = String(t).trim();
      if (!isReal(s)) continue;
      const idx = s.indexOf(':');
      const token = idx > 0 ? s.slice(0, idx).trim() : s;
      const uid = idx > 0 ? s.slice(idx + 1).trim() || null : null;
      store.addAccount(token, uid);
      keep.add(token);
    }
    for (const a of store.listAccounts()) if (!keep.has(a.token)) store.removeAccount(a.token);
    reloadAccounts();
  }
  if (isReal(body.apiKey)) state.apiKey = body.apiKey.trim();
  if (typeof body.debug === 'boolean') state.debug = body.debug;
  if (body.rotation === 'roundrobin' || body.rotation === 'pin') state.rotation = body.rotation;
  if (typeof body.sessionRotateEvery === 'number' || typeof body.sessionRotateEvery === 'string') {
    state.sessionRotateEvery = Math.max(0, parseInt(String(body.sessionRotateEvery), 10) || 0);
  }
  if (typeof body.proxyAutoRefresh === 'boolean') state.proxyAutoRefresh = body.proxyAutoRefresh;
  if (typeof body.tlsStealth === 'boolean') state.tlsStealth = body.tlsStealth;
  if (typeof body.tlsProfile === 'string' && body.tlsProfile.trim()) state.tlsProfile = body.tlsProfile.trim();
  if (typeof body.noDirect === 'boolean') state.noDirect = body.noDirect;
  const setInt = (key, val, min, max) => {
    const n = parseInt(String(val), 10);
    if (Number.isFinite(n)) state[key] = Math.min(max, Math.max(min, n));
  };
  if (body.acctRpm !== undefined) setInt('acctRpm', body.acctRpm, 1, 100000);
  if (body.globalRpm !== undefined) setInt('globalRpm', body.globalRpm, 1, 1000000);
  if (body.affinityMaxUses !== undefined) setInt('affinityMaxUses', body.affinityMaxUses, 0, 100000);
  if (body.cooldownBaseMs !== undefined) setInt('cooldownBaseMs', body.cooldownBaseMs, 0, 86400000);
  if (body.cooldownCapMs !== undefined) setInt('cooldownCapMs', body.cooldownCapMs, 0, 86400000);
  if (Array.isArray(body.proxies)) {
    pool.clear();
    state.proxies = [];
    for (const p of body.proxies) {
      const key = canonProxy(p);
      if (key && pool.add(key)) state.proxies.push(key);
    }
    // Re-apply per-account proxy bindings (pool.clear() wipes them); drop
    // bindings whose proxy is no longer in the list.
    for (const a of state.accounts) {
      if (a.proxy && !pool.setBinding(a.token, a.proxy)) store.setAccountProxy(a.token, null);
    }
    reloadAccounts();
  }
  persistSettings();
  applyStealthState();
  json(res, { ok: true, accounts: state.accounts.length, proxies: state.proxies.length, apiKey: mask(state.apiKey), rotation: state.rotation, sessionRotateEvery: state.sessionRotateEvery, proxyAutoRefresh: state.proxyAutoRefresh, tlsStealth: state.tlsStealth });
}

// ----------------------------------------------------------------- static ----

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..') || rel.includes('\0')) return json(res, { error: 'bad path' }, 400);
  const file = join(PUBLIC_DIR, rel);
  if (!existsSync(file) || !file.startsWith(PUBLIC_DIR)) return null;
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
  return true;
}

// ------------------------------------------------------------ worker bridge ---

async function pipeWorker(request, res) {
  const response = await handler.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    } catch {
      // stream errors are expected on client disconnect
    }
  }
  if (!res.writableEnded) res.end();
}

// ----------------------------------------------------------------- server ----

const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';

const server = createServer(async (nodeReq, res) => {
  const url = new URL(nodeReq.url || '/', 'http://localhost');
  const { pathname } = url;

  // OPTIONS preflight for browser dashboard
  if (nodeReq.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    });
    return res.end();
  }

  // Read the request body once, up front.
  const chunks = [];
  for await (const chunk of nodeReq) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  // --- management API (no key required for monitoring endpoints) ---
  const publicApi = ['/healthz', '/api/status'];
  const isManagement = pathname.startsWith('/api/');
  if (isManagement || pathname === '/healthz') {
    if (!publicApi.includes(pathname)) {
      const authReq = new Request('http://localhost', { headers: new Headers(nodeReq.headers) });
      if (!getApiKey(authReq)) return json(res, { error: 'Invalid API key', type: 'auth_error' }, 401);
    }
    const body = nodeReq.method === 'POST' || nodeReq.method === 'DELETE'
      ? safeParse(rawBody)
      : {};
    try {
      await routeManagement(pathname, nodeReq.method, res, body, url.searchParams);
    } catch (err) {
      console.error('[server] management error:', err?.message || err);
      if (!res.headersSent) json(res, { error: 'internal error', type: 'internal_error' }, 500);
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  // --- static dashboard ---
  if (nodeReq.method === 'GET') {
    const served = serveStatic(res, pathname);
    if (served) return;
  }

  // --- passthrough to worker (OpenAI / Anthropic API) ---
  try {
    const request = new Request(`http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: rawBody.length > 0 ? rawBody : null,
    });
    await pipeWorker(request, res);
  } catch (err) {
    console.error('[server] request error:', err.message);
    if (!res.headersSent) {
      json(res, { error: { message: 'proxy error', type: 'proxy_error' } }, 502);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

function safeParse(buf) {
  if (!buf || !buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

function routeManagement(pathname, method, res, body, query = new URLSearchParams()) {
  switch (pathname) {
    case '/healthz': return handleStatus(res);
    case '/api/status': return handleStatus(res);
    case '/api/accounts': return handleAccounts(res);
    case '/api/account': return method === 'DELETE' ? handleRemoveAccount(res, body) : handleAddAccount(res, body);
    case '/api/account/cooldown': return handleCooldownAccount(res, body);
    case '/api/account/rotate': return handleRotateAccount(res);
    case '/api/account/order': return handleOrderAccount(res, body);
    case '/api/account/proxy': return handleAccountProxy(res, body);
    case '/api/account/active': return handleSetAccountActive(res, body);
    case '/api/account/state': return handleSetAccountState(res, body);
    case '/api/account/bulk-delete': return handleBulkRemoveAccounts(res, body);
    case '/api/account/delete-banned': return handleRemoveBannedAccounts(res);
    case '/api/account/auto-proxy': return handleAutoApplyProxy(res);
    case '/api/auth/cli/code': return handleOAuthStart(res);
    case '/api/auth/cli/status': return handleOAuthStatus(res, query);
    case '/api/quota': return handleQuota(res);
    case '/api/quota/refresh': return refreshQuotaBackground().then(() => handleQuota(res));
    case '/api/models': return handleModels(res);
    case '/api/sessions': return method === 'DELETE' ? handlePurgeSessions(res) : handleSessions(res);
    case '/api/session': return method === 'POST' ? handleCreateSession(res, body) : handleDeleteSession(res, body);
    case '/api/proxies': return handleProxies(res);
    case '/api/proxy': return method === 'DELETE' ? handleRemoveProxy(res, body) : handleAddProxy(res, body);
    case '/api/proxy/test': return handleTestProxy(res, body);
    case '/api/proxy/rotate': return handleRotateProxy(res);
    case '/api/cache/clear': return handleClearCache(res);
    case '/api/config': return method === 'POST' ? handleUpdateConfig(res, body) : handleConfig(res);
    default: return json(res, { error: 'Not found', type: 'not_found' }, 404);
  }
}

server.listen(port, host, () => {
  console.log(`[server] freebuff2api listening on http://${host}:${port}`);
  console.log(`[server] accounts=${state.accounts.length} (active=${state.accounts.filter((a) => a.active).length}) proxies=${pool.size} apiKey=${mask(state.apiKey)} debug=${state.debug} rotation=${state.rotation}`);
  // Background quota refresh: kick off immediately, then on a fixed interval so
  // /api/quota never blocks (matters with hundreds of accounts).
  refreshQuotaBackground();
  setInterval(refreshQuotaBackground, QUOTA_REFRESH_MS);
  setInterval(refreshProxiesBackground, PROXY_REFRESH_MS);
});
