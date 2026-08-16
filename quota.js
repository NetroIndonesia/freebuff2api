// quota.js — per-account quota scanner.
// Probes GET /api/v1/freebuff/session with the unused-rate-limits header (a
// 0-consumption read: it observes the account's current session/quota without
// creating a session). Mirrors the reference quota_tracker.py semantics.

const BASE = "https://www.codebuff.com";
const SESSION_PATH = "/api/v1/freebuff/session";
const TIMEOUT_MS = 15000;

export const MODEL_ORDER = [
  "deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna", "minimax/minimax-m3",
  "deepseek/deepseek-v4-flash", "mimo/mimo-v2.5", "z-ai/glm-5.2",
];
const PREMIUM = new Set(["deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna", "minimax/minimax-m3"]);

function classify(status, data) {
  if (status === 200 && data && typeof data === "object") {
    if (data.status === "banned") return { state: "banned", data };
    if (data.status === "country_blocked") return { state: "country_blocked", data };
    return { state: "ok", data };
  }
  if (status === 404) return { state: "ok", data: {} };
  if (status === 401) return { state: "token_invalid", data: {} };
  if (status === 403) {
    if (data?.status === "banned") return { state: "banned", data };
    if (data?.status === "country_blocked") return { state: "country_blocked", data };
    return { state: "blocked", data };
  }
  if (status === 429) return { state: "rate_limited", data };
  return { state: "error", data, error: `HTTP ${status}` };
}

async function probeOne(token, uid) {
  try {
    const r = await fetch(BASE + SESSION_PATH, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "x-freebuff-include-unused-rate-limits": "1",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    const c = classify(r.status, data);
    return {
      token,
      uid: uid || data?.uid || null,
      state: c.state,
      error: c.error || null,
      info: data,
    };
  } catch (e) {
    return { token, uid, state: "error", error: String(e.message || e).slice(0, 120), info: {} };
  }
}

// Scan all tokens with bounded concurrency. Returns a summary consumed by the UI.
export async function scanQuota(accounts, concurrency = 3) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, accounts.length || 1) }, async () => {
    while (i < accounts.length) {
      const acct = accounts[i++];
      results.push(await probeOne(acct.token, acct.uid));
    }
  });
  await Promise.all(workers);

  const models = new Set();
  for (const r of results) {
    const rl = r.info?.rateLimitsByModel || {};
    for (const m of Object.keys(rl)) models.add(m);
  }
  const ordered = [
    ...MODEL_ORDER.filter((m) => models.has(m)),
    ...[...models].filter((m) => !MODEL_ORDER.includes(m)).sort(),
  ];

  return {
    models: ordered,
    premium: [...PREMIUM],
    accounts: results.map((r) => ({
      token: r.token,
      uid: r.uid,
      state: r.state,
      error: r.error,
      tier: r.info?.accessTier || null,
      active: r.info?.status === "active",
      expiresAt: r.info?.expiresAt || null,
      resetAt: r.info?.rateLimitsByModel
        ? Object.values(r.info.rateLimitsByModel).map((e) => e?.resetAt).find(Boolean) || null
        : null,
      glmPromo: r.info?.glmPromo || null,
      rateLimits: r.info?.rateLimitsByModel || {},
    })),
  };
}
