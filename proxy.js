// proxy.js — outbound proxy pool with rotation, health tracking and retry.
// Supports http / https (CONNECT tunnel) and socks4a / socks5 / socks5h proxies,
// built directly on undici's buildConnector so streams keep working (SSE passthrough).

import { Agent, buildConnector } from 'undici';
import { connect as netConnect } from 'node:net';
import { lookup } from 'node:dns/promises';

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks4a:': 1080, 'socks5:': 1080, 'socks5h:': 1080 };

export function parseProxy(url) {
  const u = new URL(String(url).trim());
  const proto = u.protocol.replace(/:$/, '');
  const isSocks = proto.startsWith('socks');
  if (!['http', 'https', 'socks4a', 'socks5', 'socks5h'].includes(proto)) {
    throw new Error(`unsupported proxy protocol "${proto}"`);
  }
  return {
    key: u.toString(),
    protocol: proto,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (DEFAULT_PORTS[u.protocol] || 1080),
    username: u.username ? decodeURIComponent(u.username) : '',
    password: u.password ? decodeURIComponent(u.password) : '',
    isSocks,
  };
}

// Build an undici-compatible `connect(options, callback)` that routes through one proxy.
export function makeProxyConnector(proxyUrl) {
  const proxy = parseProxy(proxyUrl);

  // Connector to reach the *proxy* itself (TLS when the proxy is https://).
  const proxyConnect = buildConnector({
    tls: proxy.protocol === 'https' ? { rejectUnauthorized: false } : undefined,
  });

  const wrapTls = (socket, options, callback) => {
    if (options.protocol !== 'https:') return callback(null, socket);
    const tlsConnect = buildConnector({});
    tlsConnect(
      { ...options, httpSocket: socket, protocol: 'https:', servername: options.servername || options.hostname || options.host },
      callback,
    );
  };

  const socksHandshake = (socket, targetHost, targetPort, options, callback) => {
    const done = (err) => {
      socket.removeAllListeners();
      if (err) { socket.destroy(); return callback(err); }
      if (buf.length) socket.unshift(buf);
      wrapTls(socket, options, callback);
    };
    const fail = (msg) => done(new Error(`socks proxy error: ${msg}`));

    // Buffered reader: keeps excess bytes for the next readN call (responses may
    // arrive coalesced in a single TCP segment).
    let buf = Buffer.alloc(0);
    let waiter = null;
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (waiter && buf.length >= waiter.n) {
        const chunk = buf.slice(0, waiter.n);
        buf = buf.slice(waiter.n);
        const cb = waiter.cb;
        waiter = null;
        cb(chunk);
      }
    });
    socket.on('error', (e) => done(e));

    const readN = (n, cb) => {
      if (buf.length >= n) {
        const chunk = buf.slice(0, n);
        buf = buf.slice(n);
        cb(chunk);
      } else {
        waiter = { n, cb };
      }
    };

    const hasAuth = proxy.username || proxy.password;
    socket.write(Buffer.from([0x05, 1, hasAuth ? 0x02 : 0x00]));
    readN(2, (resp) => {
      if (resp[0] !== 0x05) return fail('bad socks version');
      if (resp[1] === 0xff) return fail('no acceptable auth method');
      if (resp[1] === 0x02) {
        const u = Buffer.from(proxy.username);
        const p = Buffer.from(proxy.password);
        if (u.length > 255 || p.length > 255) return fail('auth too long');
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        return readN(2, (authResp) => {
          if (authResp[1] !== 0x00) return fail('socks auth rejected');
          sendConnect();
        });
      }
      if (resp[1] !== 0x00) return fail('auth required');
      sendConnect();
    });

    const sendConnect = () => {
      const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
      const remoteDns = proxy.protocol === 'socks5h' || proxy.protocol === 'socks4a';
      const finish = (head) => {
        if (head[0] !== 0x05) return fail('bad connect version');
        if (head[1] !== 0x00) return fail('connect refused code ' + head[1]);
        const alen = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : head[3] === 0x03 ? 1 : 0;
        const readBind = () => readN(alen, () => readN(2, () => done(null)));
        if (head[3] === 0x03) readN(1, (l) => readN(l[0], () => readN(2, () => done(null))));
        else readBind();
      };
      if (remoteDns) {
        const addr = Buffer.from(targetHost, 'utf8');
        if (addr.length > 255) return fail('hostname too long');
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, addr.length]), addr, portBuf]));
        readN(4, finish);
      } else {
        lookup(targetHost, { family: 4 }).then(({ address }) => {
          const ip = address.split('.').map(Number);
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip]), portBuf]));
          readN(4, finish);
        }).catch(() => fail('dns resolve failed'));
      }
    };
  };

  const httpTunnel = (socket, targetHost, targetPort, options, callback) => {
    const auth = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
      : '';
    socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`);

    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      socket.off('error', onErr);
      const statusLine = buf.slice(0, idx).toString('latin1').split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/\S+\s+(\d{3})/);
      if (!m || m[1] !== '200') {
        socket.destroy();
        return callback(new Error(`proxy CONNECT failed: ${statusLine || 'no response'}`));
      }
      const leftover = buf.slice(idx + 4);
      if (leftover.length) socket.unshift(leftover);
      wrapTls(socket, options, callback);
    };
    const onErr = (e) => { socket.off('data', onData); callback(e); };
    socket.on('data', onData);
    socket.on('error', onErr);
  };

  return function connect(options, callback) {
    const targetHost = options.hostname || options.host;
    const targetPort = options.port || (options.protocol === 'https:' ? 443 : 80);
    proxyConnect(
      { ...options, hostname: proxy.hostname, host: proxy.hostname, port: proxy.port, protocol: proxy.protocol === 'https' ? 'https:' : 'http:' },
      (err, proxySocket) => {
        if (err) return callback(err);
        if (proxy.isSocks) socksHandshake(proxySocket, targetHost, targetPort, options, callback);
        else httpTunnel(proxySocket, targetHost, targetPort, options, callback);
      },
    );
  };
}

// ProxyPool — round-robin rotation with health/cooldown and direct-connection fallback.
export class ProxyPool {
  constructor(urls = []) {
    this.entries = new Map(); // key -> { key, protocol, url, agent, fails, lastUsed, lastOk, cooldownUntil, latencyMs }
    this.order = [];
    this.idx = 0;
    this.bindings = new Map(); // token -> proxy key (per-account proxy pinning)
    for (const u of urls) this.add(u);
  }

  add(url) {
    try {
      const info = parseProxy(url);
      if (this.entries.has(info.key)) return false;
      const agent = new Agent({ connect: makeProxyConnector(info.key), pipelining: 0 });
      this.entries.set(info.key, { ...info, agent, fails: 0, lastUsed: 0, lastOk: 0, cooldownUntil: 0, latencyMs: null });
      this.order.push(info.key);
      return true;
    } catch {
      return false;
    }
  }

  remove(url) {
    let key = String(url).trim();
    try { key = parseProxy(key).key; } catch { return false; }
    if (!this.entries.has(key)) return false;
    const entry = this.entries.get(key);
    try { entry.agent.destroy(); } catch {}
    this.entries.delete(key);
    this.order = this.order.filter((k) => k !== key);
    return true;
  }

  get size() { return this.order.length; }

  list() {
    return this.order.map((key) => {
      const e = this.entries.get(key);
      return {
        url: key,
        protocol: e.protocol,
        host: e.hostname,
        port: e.port,
        state: e.cooldownUntil > Date.now() ? 'cooldown' : 'ready',
        fails: e.fails,
        latencyMs: e.latencyMs,
        lastUsed: e.lastUsed || null,
      };
    });
  }

  // Pick the next healthy proxy dispatcher. Returns null for a direct connection.
  next(now = Date.now()) {
    const ready = this.order.filter((k) => {
      const e = this.entries.get(k);
      return e && e.cooldownUntil <= now;
    });
    if (ready.length === 0) return null;
    for (let i = 0; i < ready.length; i++) {
      const key = ready[this.idx % ready.length];
      this.idx = (this.idx + 1) % ready.length;
      const e = this.entries.get(key);
      if (e) { e.lastUsed = now; return { key, dispatcher: e.agent }; }
    }
    return null;
  }

  reportSuccess(key, latencyMs) {
    const e = this.entries.get(key);
    if (!e) return;
    e.fails = 0;
    e.lastOk = Date.now();
    e.cooldownUntil = 0;
    if (typeof latencyMs === 'number') e.latencyMs = latencyMs;
  }

  // Exponential backoff: 2s, 8s, 32s… capped at 5min.
  reportFailure(key) {
    const e = this.entries.get(key);
    if (!e) return;
    e.fails += 1;
    const backoff = Math.min(300000, 2000 * 4 ** (e.fails - 1));
    e.cooldownUntil = Date.now() + backoff;
  }

  // Manual rotation: advance the cursor one step (does not remove cooldowns).
  rotate() {
    if (this.order.length === 0) return 0;
    this.idx = (this.idx + 1) % this.order.length;
    return this.idx;
  }

  // Pin a token to a specific proxy. Empty/null proxyUrl clears the binding.
  setBinding(token, proxyUrl) {
    if (!token) return false;
    if (!proxyUrl) { this.bindings.delete(token); return true; }
    let key;
    try { key = parseProxy(String(proxyUrl)).key; } catch { return false; }
    if (!this.entries.has(key)) return false;
    this.bindings.set(token, key);
    return true;
  }

  clearBinding(token) { return this.bindings.delete(token); }

  listBindings() {
    return [...this.bindings.entries()].map(([token, key]) => ({ token, proxy: key }));
  }

  // Resolve a bound dispatcher for a token, falling back to null (auto-rotate).
  bindingDispatcher(token) {
    if (!token) return null;
    const key = this.bindings.get(token);
    if (!key) return null;
    const e = this.entries.get(key);
    if (!e || e.cooldownUntil > Date.now()) return null; // bound proxy down -> auto-rotate
    e.lastUsed = Date.now();
    return { key, dispatcher: e.agent };
  }

  clear() {
    for (const key of this.order) {
      try { this.entries.get(key)?.agent.destroy(); } catch {}
    }
    this.entries.clear();
    this.order = [];
    this.idx = 0;
    this.bindings.clear();
  }
}
