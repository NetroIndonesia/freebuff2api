// store.js — SQLite persistence (better-sqlite3). Holds accounts with
// per-account metadata (active/inactive, proxy binding, manual state override),
// settings, and the background quota cache.

import Database from 'better-sqlite3';

let db = null;

export function initStore(path) {
  db = new Database(path);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    token TEXT PRIMARY KEY,
    uid TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    proxy TEXT,
    state TEXT,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  return db;
}

// ---- settings ----

export function getSetting(key, def = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch { return def; }
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

// ---- accounts ----

export function listAccounts() {
  return db.prepare('SELECT token, uid, active, proxy, state, added_at FROM accounts ORDER BY added_at, token')
    .all()
    .map((r) => ({
      token: r.token,
      uid: r.uid || null,
      active: !!r.active,
      proxy: r.proxy || null,
      state: r.state || null,
      addedAt: r.added_at,
    }));
}

export function addAccount(token, uid = null) {
  db.prepare('INSERT INTO accounts (token, uid, active) VALUES (?, ?, 1) ON CONFLICT(token) DO UPDATE SET uid = COALESCE(excluded.uid, accounts.uid)')
    .run(token, uid || null);
}

export function removeAccount(token) {
  db.prepare('DELETE FROM accounts WHERE token = ?').run(token);
}

export function setAccountActive(token, active) {
  db.prepare('UPDATE accounts SET active = ? WHERE token = ?').run(active ? 1 : 0, token);
}

export function setAccountProxy(token, proxy) {
  db.prepare('UPDATE accounts SET proxy = ? WHERE token = ?').run(proxy || null, token);
}

export function setAccountState(token, state) {
  db.prepare('UPDATE accounts SET state = ? WHERE token = ?').run(state || null, token);
}

export function setAccountUid(token, uid) {
  db.prepare('UPDATE accounts SET uid = ? WHERE token = ?').run(uid || null, token);
}


function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
