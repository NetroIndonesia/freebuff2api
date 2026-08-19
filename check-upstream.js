// check-upstream.js — daily upstream drift watchdog for freebuff2api.
//
// The upstream Freebuff client (CodebuffAI/freebuff) is synced to GitHub many
// times a day. This gateway re-implements its wire protocol and re-parses its
// model catalog, so an upstream change can silently break the gateway. This
// tool fetches the exact sources the engine parses, runs the REAL engine
// parser against them, and reports anything important that changed since the
// last run.
//
//   node check-upstream.js
//
// Exit codes: 0 = nothing important changed; 1 = important change detected
// (new/removed model, pool reclassification, effort-ladder drift, missing
// "Buffy" marker, or the parser falling back to the hardcoded table).
// State is kept in .upstream-snapshot.json (gitignored).
//
// Wire it to a schedule yourself, e.g. Windows Task Scheduler or:
//   node check-upstream.js || echo "UPSTREAM CHANGED — review engine.js"

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { internals } from "./engine.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(ROOT, ".upstream-snapshot.json");

// Same sources engine.js uses (raw + jsDelivr mirror).
const SOURCES = {
  agents: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/free-agents.ts",
  ],
  models: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-models.ts",
  ],
  ids: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-model-ids.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-model-ids.ts",
  ],
  ads: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/util/ad-user-agent.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/util/ad-user-agent.ts",
  ],
  adsFlow: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/cli/src/hooks/use-gravity-ad.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/cli/src/hooks/use-gravity-ad.ts",
  ],
};

// The free-mode marker the upstream server requires at position 0 of the
// system prompt (see FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS in free-agents.ts).
// engine.js sends exactly this. If upstream drops it, every request 403s.
const BUFFY_MARKER = "You are Buffy, the strategic coding assistant.";

const FETCH_TIMEOUT_MS = 10000;

async function fetchText(urls) {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 100) return text;
      }
    } catch {}
  }
  return null;
}

// ---- pool parsing (faithful copy of engine.js parseModelIdConstants/parseModelPools) ----

function parseModelIdConstants(src) {
  const knownDefaults = { mimoV25: "mimo/mimo-v2.5" };
  const map = {};
  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*(?:(?:'([^']*)')|(?:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+))|(?:([A-Za-z0-9_]+)))/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1], lit = m[2], obj = m[3], member = m[4], ident = m[5];
    if (lit) map[name] = lit;
    else if (obj && member && knownDefaults[member]) map[name] = knownDefaults[member];
    else if (ident && map[ident]) map[name] = map[ident];
  }
  return map;
}

function parseModelPools(src, modelIdConstants) {
  const premium = new Set();
  const glm = new Set();
  const constValues = new Map();
  const constListRe = /export\s+const\s+([A-Z0-9_]+)\s*=\s*\[([^\]]*)\]\s*as\s*const/g;
  let cm;
  while ((cm = constListRe.exec(src)) !== null) {
    const name = cm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(cm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) items.push(["spread", spread]);
      else if (lit) items.push(["lit", lit]);
      else if (expr && modelIdConstants[expr]) items.push(["lit", modelIdConstants[expr]]);
    }
    constValues.set(name, items);
  }
  const poolRe = /export\s+const\s+(FREEBUFF_WEB_PREMIUM_MODEL_IDS|FREEBUFF_GLM_V52_MODEL_IDS|FREEBUFF_PREMIUM_MODEL_IDS)\s*=\s*\[([^\]]*)\]/g;
  let pm;
  while ((pm = poolRe.exec(src)) !== null) {
    const poolName = pm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(pm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) {
        const expand = (n) => {
          const entries = constValues.get(n) || [];
          for (const [kind, val] of entries) {
            if (kind === "spread") expand(val);
            else items.push(val);
          }
        };
        expand(spread);
      } else if (lit) items.push(lit);
      else if (expr && modelIdConstants[expr]) items.push(modelIdConstants[expr]);
    }
    if (poolName === "FREEBUFF_GLM_V52_MODEL_IDS") {
      for (const id of items) glm.add(id);
    } else {
      for (const id of items) premium.add(id);
    }
  }
  return { premium: [...premium], glm: [...glm] };
}

// ---- effort-ladder parsing (upstream model option `efforts:` fields) ----

// Resolve effort constants defined in freebuff-models.ts to their arrays.
function parseEffortConstants(src) {
  const map = {};
  const re = /(?:export\s+)?const\s+(EFFORTS_THROUGH_[A-Z_]+|DEEPSEEK_V4_REASONING_EFFORTS)\s*=\s*\[([^\]]*)\]\s*as\s*const/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    map[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  }
  return map;
}

// Parse each `const X_MODEL = { ... }` block: id + efforts (constant or inline).
function parseModelEfforts(src, modelIdConstants) {
  const effortConsts = parseEffortConstants(src);
  const out = {};
  const blockRe = /const\s+(\w+_MODEL)\s*=\s*\{([\s\S]*?)\}\s*as\s*const\s+satisfies\s+FreebuffModelOption/g;
  let b;
  while ((b = blockRe.exec(src)) !== null) {
    const body = b[2];
    const idMatch = body.match(/id:\s*(?:'([^']+)'|([A-Z0-9_]+))/);
    if (!idMatch) continue;
    const id = idMatch[1] || (modelIdConstants[idMatch[2]] || null);
    if (!id) continue;
    const effortMatch = body.match(/efforts:\s*(EFFORTS_THROUGH_[A-Z_]+|DEEPSEEK_V4_REASONING_EFFORTS|\[[^\]]*\])/);
    let ladder = null;
    if (effortMatch) {
      ladder = effortMatch[1].startsWith("[")
        ? [...effortMatch[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
        : (effortConsts[effortMatch[1]] || null);
    }
    out[id] = ladder;
  }
  return out;
}

// ---- ad-chain parsing (engine.js runNormalClientBehavior / browserUserAgent) ----

// Browser UA version the engine must send to ad providers. Upstream treats a
// stale Chrome version as a bot fingerprint (see ad-user-agent.ts).
function parseAdChromeVersion(src) {
  const m = /const AD_CHROME_VERSION = ['"]([^'"]+)['"]/.exec(src || "");
  return m ? m[1] : null;
}

// Zeroclick impressions URL + provider/surface unions from use-gravity-ad.ts.
function parseAdFlow(src) {
  if (!src) return { zeroclickUrl: null, providers: null, surfaces: null };
  const url = /ZEROCLICK_IMPRESSIONS_URL = ['"]([^'"]+)['"]/.exec(src);
  const providers = /type AdProvider = ([^\n]+)/.exec(src);
  const surfaces = /type AdSurface = ([^\n]+)/.exec(src);
  const norm = (s) =>
    s ? [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]).join(",") : null;
  return {
    zeroclickUrl: url ? url[1] : null,
    providers: norm(providers ? providers[1] : null),
    surfaces: norm(surfaces ? surfaces[1] : null),
  };
}

// ---- snapshot ----

function loadSnapshot() {
  try {
    if (existsSync(SNAPSHOT_PATH)) return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {}
  return null;
}

// ---- main ----

async function main() {
  const [agentsSrc, modelsSrc, idsSrc, adsSrc, adsFlowSrc] = await Promise.all([
    fetchText(SOURCES.agents),
    fetchText(SOURCES.models),
    fetchText(SOURCES.ids),
    fetchText(SOURCES.ads),
    fetchText(SOURCES.adsFlow),
  ]);

  const problems = [];
  const notes = [];

  if (!agentsSrc || !modelsSrc) {
    console.error("check-upstream: could not fetch upstream sources (network?)");
    process.exit(2);
  }

  // 1) Buffy marker — critical, would 403 every request if dropped.
  const markerOk = agentsSrc.includes(BUFFY_MARKER);

  // 2) Real engine parser against current upstream.
  let table = [];
  let parserFellBack = false;
  try {
    table = await internals.modelTable();
    // modelTable() returns the hardcoded MODELS (1 entry) when the dynamic
    // registry failed to parse — that is a silent break.
    parserFellBack = table.length <= 1 && !table.some((m) => m.id !== "mimo/mimo-v2.5");
  } catch (e) {
    parserFellBack = true;
  }

  // 3) Pools (faithful engine parse).
  const modelIdConstants = { ...parseModelIdConstants(idsSrc || ""), ...parseModelIdConstants(modelsSrc) };
  const pools = parseModelPools(modelsSrc, modelIdConstants);
  const standard = table.filter((m) => !pools.premium.includes(m.id) && !pools.glm.includes(m.id)).map((m) => m.id);

  const classify = (id) =>
    pools.premium.includes(id) ? "premium" : pools.glm.includes(id) ? "glm" : standard.includes(id) ? "standard" : "null";

  const current = {
    checkedAt: new Date().toISOString(),
    markerOk,
    parserFellBack,
    models: Object.fromEntries(table.map((m) => [m.id, classify(m.id)])),
    efforts: parseModelEfforts(modelsSrc || "", modelIdConstants),
    ad: {
      chromeVersion: parseAdChromeVersion(adsSrc || ""),
      ...parseAdFlow(adsFlowSrc || ""),
    },
  };

  // 4) Diff against last snapshot.
  const prev = loadSnapshot();
  const changes = [];

  if (prev) {
    if (prev.markerOk && !markerOk) {
      changes.push(`[CRITICAL] Upstream dropped the "Buffy" marker — every request will 403. Update engine.js BUFFY.`);
    }
    if (!prev.parserFellBack && parserFellBack) {
      changes.push(`[CRITICAL] Engine parser now FALLS BACK to the hardcoded table — upstream format changed. Review parseModel* in engine.js.`);
    }
    const prevModels = prev.models || {};
    for (const [id, cat] of Object.entries(current.models)) {
      if (!(id in prevModels)) changes.push(`[NEW] model ${id} (${cat})`);
      else if (prevModels[id] !== cat) changes.push(`[POOL] ${id}: ${prevModels[id]} -> ${cat}`);
    }
    for (const id of Object.keys(prevModels)) {
      if (!(id in current.models)) changes.push(`[REMOVED] model ${id}`);
    }
    // effort-ladder drift
    const prevEfforts = prev.efforts || {};
    for (const [id, ladder] of Object.entries(current.efforts)) {
      if (ladder && prevEfforts[id] && JSON.stringify(prevEfforts[id]) !== JSON.stringify(ladder)) {
        changes.push(`[EFFORT] ${id}: ${prevEfforts[id].join("/")} -> ${ladder.join("/")}`);
      }
    }
    // ad-chain drift (browser UA version / zeroclick URL / provider-surface set)
    const prevAd = prev.ad || {};
    if (prevAd.chromeVersion && current.ad.chromeVersion && prevAd.chromeVersion !== current.ad.chromeVersion) {
      changes.push(`[AD] browser UA Chrome ${prevAd.chromeVersion} -> ${current.ad.chromeVersion} (update engine.js browserUserAgent)`);
    }
    if (prevAd.zeroclickUrl && current.ad.zeroclickUrl && prevAd.zeroclickUrl !== current.ad.zeroclickUrl) {
      changes.push(`[AD] zeroclick URL ${prevAd.zeroclickUrl} -> ${current.ad.zeroclickUrl} (update engine.js ZEROCLICK_IMPRESSIONS_URL)`);
    }
    if (prevAd.providers && current.ad.providers && prevAd.providers !== current.ad.providers) {
      changes.push(`[AD] providers ${prevAd.providers} -> ${current.ad.providers}`);
    }
    if (prevAd.surfaces && current.ad.surfaces && prevAd.surfaces !== current.ad.surfaces) {
      changes.push(`[AD] surfaces ${prevAd.surfaces} -> ${current.ad.surfaces}`);
    }
  } else {
    notes.push("first run — snapshot created, no baseline to diff yet");
  }

  // 5) Report.
  console.log(`Upstream check @ ${current.checkedAt}`);
  console.log(`  marker "Buffy":     ${markerOk ? "OK" : "MISSING (CRITICAL)"}`);
  console.log(`  engine parser:      ${parserFellBack ? "FALLBACK (CRITICAL)" : "OK"}`);
  console.log(`  models parsed:      ${table.length}`);
  for (const [id, cat] of Object.entries(current.models)) console.log(`    - ${id}  [${cat}]`);
  console.log("  effort ladders:");
  for (const [id, ladder] of Object.entries(current.efforts)) {
    console.log(`    - ${id}: ${ladder ? ladder.join("/") : "(none)"}`);
  }
  console.log("  ad chain:");
  console.log(`    - browser UA: Chrome ${current.ad.chromeVersion || "?"}`);
  console.log(`    - providers:  ${current.ad.providers || "?"}`);
  console.log(`    - surfaces:   ${current.ad.surfaces || "?"}`);
  console.log(`    - zeroclick:  ${current.ad.zeroclickUrl || "(none)"}`);

  if (changes.length) {
    console.log("\nIMPORTANT CHANGES:");
    for (const c of changes) console.log(`  ${c}`);
  }
  for (const n of notes) console.log(`\nnote: ${n}`);

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2));

  const important = changes.length > 0 || !markerOk || parserFellBack;
  process.exit(important ? 1 : 0);
}

main().catch((e) => {
  console.error("check-upstream crashed:", e);
  process.exit(2);
});
