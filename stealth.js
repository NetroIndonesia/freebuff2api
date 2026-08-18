// stealth.js — optional browser TLS / HTTP2 fingerprint impersonation for all
// upstream traffic. Wraps impers (libcurl-impersonate via Koffi FFI) behind the
// fetch() signature used by engine.js / quota.js, so those modules need zero
// changes: server.js routes proxiedFetch through here when TLS_STEALTH=1.
//
// Why this exists: the default Node/undici TLS ClientHello (OpenSSL shape —
// 48 ciphers, extended-master-secret extension first) is instantly recognized
// by JA3/JA4 fingerprinting, and the official CLI is a Bun app whose
// fingerprint is different again. Impersonating a real browser makes the whole
// upstream conversation look like the Freebuff web client instead.
//
// Enabled with TLS_STEALTH=1. Profile via TLS_PROFILE (default "chrome" →
// newest Chrome; also "chrome136", "safari2601", "firefox147", "edge101", ...).

import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// impers is imported lazily (loadImpers): its index eagerly loads libcurl via
// Koffi and throws if the DLL is absent, so the Windows binary is self-healed
// first. impers' own Windows auto-download is broken — its extractor only keeps
// archive entries under `bin/`, but lexiforest's win32 package ships the DLL
// under `lib/`. The fallback below downloads the pinned asset and places the
// DLL where impers' recursive cache scan finds it. Override the version with
// LIBCURL_IMPERSONATE_VERSION, or disable with IMPER_DOWNLOAD_LIBCURL=0.
const WIN_LIBCURL_VERSION = process.env.LIBCURL_IMPERSONATE_VERSION || 'v2.1.0';
const WIN_ARCH = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'i686' : process.arch;

// Common aliases impers resolves (the full alias table is internal; keep the
// ones an operator would actually set. Versioned names like "chrome136" are
// already in the native target list and need no entry here.)
const PROFILE_ALIASES = {
  chrome: 'chrome146',
  safari: 'safari2601',
  firefox: 'firefox147',
  edge: 'edge101',
  tor: 'tor145',
  chrome_android: 'chrome131_android',
  safari_ios: 'safari260_ios',
};

const STEALTH = ['1', 'true', 'yes'].includes(String(process.env.TLS_STEALTH || '').toLowerCase());
let profile = process.env.TLS_PROFILE || 'chrome';

export const stealthEnabled = STEALTH;

// Fatal, non-transient: libcurl-impersonate missing/broken. server.js latches
// this and falls back to plain undici fetch for the rest of the process.
export class StealthUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StealthUnavailableError';
  }
}

function winCacheDir() {
  if (process.env.IMPER_CACHE_DIR) return join(process.env.IMPER_CACHE_DIR, 'win32-x64');
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  return base ? join(base, 'impers', 'libcurl-impersonate', 'win32-x64') : null;
}

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'freebuff2api' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpsGetBuffer(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('libcurl download timeout')));
  });
}

// Minimal ustar reader — we only want the libcurl-impersonate.dll entry.
function extractDllFromTar(tarball) {
  let offset = 0;
  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (!name && !prefix) break;
    const sizeStr = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!Number.isFinite(size)) break;
    const full = prefix ? `${prefix}/${name}` : name;
    if (full.endsWith('libcurl-impersonate.dll')) {
      return tarball.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function ensureWinLibcurl() {
  if (process.platform !== 'win32' || process.env.IMPER_DOWNLOAD_LIBCURL === '0') return false;
  const dir = winCacheDir();
  if (!dir) return false;
  const dllPath = join(dir, 'libcurl-impersonate.dll');
  if (existsSync(dllPath)) return true;
  const url = `https://github.com/lexiforest/curl-impersonate/releases/download/${WIN_LIBCURL_VERSION}/libcurl-impersonate-${WIN_LIBCURL_VERSION}.${WIN_ARCH}-win32.tar.gz`;
  const dll = extractDllFromTar(gunzipSync(await httpsGetBuffer(url)));
  if (!dll) throw new Error('libcurl-impersonate.dll not found in archive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(dllPath, dll);
  return true;
}

let impersMod = null;
async function loadImpers() {
  if (!impersMod) {
    if (process.platform === 'win32') await ensureWinLibcurl();
    impersMod = await import('impers');
  }
  return impersMod;
}

let readyPromise = null;
let warnedProfile = false;

async function ensureReady() {
  if (!STEALTH) throw new StealthUnavailableError('TLS_STEALTH is disabled');
  if (!readyPromise) {
    readyPromise = (async () => {
      const { resolveLibrary, NATIVE_IMPERSONATE_TARGETS } = await loadImpers();
      let info = await resolveLibrary();
      if ((!info || !info.path || !info.isImpersonate) && (await ensureWinLibcurl())) {
        info = await resolveLibrary();
      }
      if (!info || !info.path) {
        throw new StealthUnavailableError('libcurl-impersonate not found — set LIBCURL_PATH');
      }
      if (!info.isImpersonate) {
        throw new StealthUnavailableError('resolved libcurl has no impersonation support (system libcurl?)');
      }
      const targets = new Set(NATIVE_IMPERSONATE_TARGETS.map((t) => t.target_name));
      const resolved = PROFILE_ALIASES[profile] || profile;
      if (!targets.has(resolved)) {
        if (!warnedProfile) {
          warnedProfile = true;
          console.warn(`[stealth] TLS_PROFILE "${profile}" is unknown — falling back to "chrome"`);
        }
        profile = 'chrome';
      }
      return true;
    })();
    readyPromise.catch(() => {}); // errors surface per-call
  }
  return readyPromise;
}

// Convert fetch-style Headers (object / Headers instance) to a plain object.
function toPlainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.get === 'function' && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined) out[k] = String(v);
    }
  }
  // The browser UA (matching the impersonated TLS profile) comes from impers
  // defaultHeaders; an explicit UA (e.g. the CLI one used by the ad chain)
  // would contradict the fingerprint, so drop it in stealth mode.
  delete out['user-agent'];
  delete out['User-Agent'];
  return out;
}

function makeHeaderState() {
  return { buf: '', status: 0, statusText: '', headers: {}, blockDone: false };
}

// Incremental parser for curl's raw header callback. One call per line; the
// block ends with an empty line. Redirects produce several status lines; the
// last one seen before the body wins (only reached once the body starts).
function pushHeaderData(chunk, state) {
  state.buf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
  while (true) {
    let idx = state.buf.indexOf('\r\n');
    if (idx === -1) idx = state.buf.indexOf('\n');
    if (idx === -1) break;
    let line = state.buf.slice(0, idx);
    state.buf = state.buf.slice(idx + (state.buf[idx] === '\r' && state.buf[idx + 1] === '\n' ? 2 : 1));
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      state.blockDone = true;
      continue;
    }
    const statusMatch = line.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
    if (statusMatch) {
      state.status = Number(statusMatch[1]);
      state.statusText = statusMatch[2] || '';
      state.headers = {};
      continue;
    }
    const ci = line.indexOf(':');
    if (ci > 0) {
      const key = line.slice(0, ci).trim().toLowerCase();
      const value = line.slice(ci + 1).trim();
      if (key) state.headers[key] = value;
    }
  }
}

/**
 * fetch()-compatible upstream request with a browser TLS/HTTP2 fingerprint.
 * Returns a real Response whose body streams incrementally (SSE passthrough).
 *
 * @param {string|URL|Request} input
 * @param {RequestInit} init  method / headers / body / signal (abort supported)
 * @param {{ proxy?: string|null }} opts  proxy URL for libcurl (undici
 *   `dispatcher` is NOT understood here — server.js passes the pool's URL)
 */
export async function stealthFetch(input, init = {}, opts = {}) {
  await ensureReady();
  const { request } = await loadImpers();

  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : input && input.url ? input.url
    : String(input);
  const method = String(init.method || 'GET').toUpperCase();
  const headers = toPlainHeaders(init.headers);
  const body = init.body;
  if (body != null && typeof body.pipe === 'function') {
    throw new TypeError('stealth: streaming request bodies are not supported');
  }

  // Merge the caller's abort signal with stream-cancel into one internal
  // controller; impers aborts the transfer on signal.abort.
  const internalAbort = new AbortController();
  const outerSignal = init.signal;
  if (outerSignal) {
    if (outerSignal.aborted) internalAbort.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => internalAbort.abort(outerSignal.reason), { once: true });
  }

  let controller = null;
  let resolveMeta = null;
  let metaResolved = false;
  const meta = new Promise((resolve) => { resolveMeta = resolve; });
  const finishMeta = (status, statusText, headers) => {
    if (!metaResolved) {
      metaResolved = true;
      resolveMeta({ status, statusText, headers });
    }
  };

  const bodyStream = new ReadableStream({
    start(c) { controller = c; },
    cancel() { internalAbort.abort(new Error('stream cancelled')); },
  });

  const hs = makeHeaderState();

  const reqOpts = {
    headers,
    stream: true,
    impersonate: profile,
    signal: internalAbort.signal,
    acceptEncoding: 'identity', // no content-encoding → SSE parser gets raw bytes
    contentCallback: (chunk) => {
      // First body data ⇒ headers are final (redirects resolve before the
      // body starts): surface the Response now so streaming can begin.
      if (!metaResolved) finishMeta(hs.status || 502, hs.statusText, hs.headers);
      if (controller) { try { controller.enqueue(chunk); } catch { /* stream closed */ } }
    },
    headerCallback: (chunk) => { pushHeaderData(chunk, hs); },
  };
  if (opts.proxy) reqOpts.proxy = opts.proxy;
  if (body !== undefined && body !== null) {
    reqOpts.content = Buffer.isBuffer(body) ? body : String(body);
  }

  const pending = request(method, url, reqOpts).then(
    (resp) => {
      // No body at all (e.g. 204): resolve from headers, close the stream.
      if (!metaResolved) finishMeta(hs.status || resp.statusCode || 502, hs.statusText, hs.headers);
      if (controller) { try { controller.close(); } catch { /* already closed */ } }
      return resp;
    },
    (err) => {
      if (!metaResolved) finishMeta(0, '', {}); // pre-header failure
      if (controller) { try { controller.error(err); } catch { /* stream closed */ } }
      throw err;
    },
  );

  // Post-header failures/aborts surface through the stream to the reader; the
  // underlying promise is otherwise unconsumed, so swallow its rejection to
  // avoid an unhandled-rejection crash. The pre-header case below still rethrows.
  pending.catch(() => {});

  const m = await meta;
  if (m.status === 0) {
    // Failed before any headers arrived — surface the underlying error.
    throw await pending.catch((e) => e);
  }
  const nullBody = method === 'HEAD' || m.status === 204 || m.status === 205 || m.status === 304;
  return new Response(nullBody ? null : bodyStream, {
    status: m.status,
    statusText: m.statusText,
    headers: m.headers,
  });
}
