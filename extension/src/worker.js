/*
 * HOOKPRINT — worker.js
 * MV3 service worker. See extension/ARCHITECTURE.md, CONTRACT.md, src/EVENTS.md.
 *
 * The coordinator. It owns:
 *   - per-tab event storage, bounded, with a session.session_id reset rule
 *     that needs no "tabs" permission;
 *   - source fetching and snippet resolution — the MAIN world cannot read a
 *     cross-origin script's text, an extension with host permissions can, so
 *     evidence.snippet is filled in HERE and nowhere else;
 *   - the detector seam: detectors are cyborg's, are pure, and are optional —
 *     this file runs without them and says so;
 *   - assembly and CONTRACT.md enforcement of the Manifest;
 *   - kill-switch arm/disarm dispatch down to bridge.js.
 *
 * It contains no detection logic of its own.
 */

const CFG = {
  MAX_EVENTS_PER_TAB: 20000,
  SNAPSHOT_EVENTS: 4000,
  SNAPSHOT_DEBOUNCE_MS: 5000,
  MAX_SOURCES: 40,
  SNIPPET_MAX: 240,
  SNIPPET_BEFORE: 80,
  SNIPPET_AFTER: 160,
  SOURCE_FETCH_TIMEOUT_MS: 4000
};

const MECHANISMS = new Set([
  "infinite_scroll", "autoplay", "variable_interval_refetch",
  "countdown_timer", "scarcity_message", "unknown"
]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

/* ===================================================================== *
 * Per-tab session state
 * ===================================================================== */

const tabs = new Map();          // tabId -> { session_id, url, t0, events[], truncated, dropped_by_worker }
const snapshotTimers = new Map();

function blankTab(sessionId, url) {
  return { session_id: sessionId, url: url, t0: Date.now(), events: [], truncated: false, last_seen: Date.now() };
}

async function getTab(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  // The service worker may have been evicted since the events arrived.
  try {
    const stored = await chrome.storage.session.get("hp_tab_" + tabId);
    const s = stored["hp_tab_" + tabId];
    if (s && s.events) { tabs.set(tabId, s); return s; }
  } catch (e) { /* storage.session unavailable; carry on in memory */ }
  return null;
}

function scheduleSnapshot(tabId) {
  if (snapshotTimers.has(tabId)) return;
  const h = setTimeout(() => {
    snapshotTimers.delete(tabId);
    const st = tabs.get(tabId);
    if (!st) return;
    const trimmed = {
      session_id: st.session_id, url: st.url, t0: st.t0, truncated: st.truncated,
      last_seen: st.last_seen,
      events: st.events.length > CFG.SNAPSHOT_EVENTS ? st.events.slice(-CFG.SNAPSHOT_EVENTS) : st.events
    };
    chrome.storage.session.set({ ["hp_tab_" + tabId]: trimmed }).catch(() => {});
  }, CFG.SNAPSHOT_DEBOUNCE_MS);
  snapshotTimers.set(tabId, h);
}

async function ingest(tabId, sessionId, url, events) {
  let st = await getTab(tabId);
  // A new session_id for this tab means a new document. This is how the
  // worker detects navigation WITHOUT the "tabs" permission — we never need
  // to read a tab's URL to know it changed.
  if (!st || st.session_id !== sessionId) {
    st = blankTab(sessionId, url);
    tabs.set(tabId, st);
  }
  st.url = url || st.url;
  st.last_seen = Date.now();
  for (const e of events) {
    if (st.events.length >= CFG.MAX_EVENTS_PER_TAB) { st.truncated = true; break; }
    st.events.push(e);
  }
  scheduleSnapshot(tabId);
  return st;
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
    const h = snapshotTimers.get(tabId);
    if (h) { clearTimeout(h); snapshotTimers.delete(tabId); }
    chrome.storage.session.remove("hp_tab_" + tabId).catch(() => {});
  });
} catch (e) { /* onRemoved is available without the tabs permission; guard anyway */ }

/* ===================================================================== *
 * Source fetching + snippet resolution
 *
 * CONTRACT.md rule 1: a candidate that cannot be tied to a real file, line
 * and source snippet does not become a Finding. This is where that is
 * enforced, and it is the only place with the ability to enforce it.
 * ===================================================================== */

const sources = new Map();       // url -> { ok, lines } | { ok:false, reason }

async function getSource(url) {
  if (sources.has(url)) return sources.get(url);
  if (sources.size >= CFG.MAX_SOURCES) {
    const first = sources.keys().next().value;
    sources.delete(first);
  }
  let rec;
  if (!/^https?:/i.test(url)) {
    // blob:, data:, chrome-extension:, about: — a blob URL in particular is
    // scoped to the page and is simply not fetchable from here.
    rec = { ok: false, reason: "unfetchable scheme" };
  } else {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), CFG.SOURCE_FETCH_TIMEOUT_MS);
      const res = await fetch(url, { credentials: "omit", signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) rec = { ok: false, reason: "HTTP " + res.status };
      else {
        const text = await res.text();
        rec = { ok: true, lines: text.split("\n") };
      }
    } catch (e) {
      rec = { ok: false, reason: (e && e.name === "AbortError") ? "fetch timeout" : "fetch failed" };
    }
  }
  sources.set(url, rec);
  return rec;
}

/* A real site ships one minified line of 200 KB. Returning that line whole is
 * useless to a reader and lethal to the panel, so the snippet is a window
 * centred on the COLUMN, which is the part of the call site everyone forgets
 * is load-bearing. */
function windowLine(raw, column) {
  if (raw.length <= CFG.SNIPPET_MAX) return raw.trim();
  const c = Math.max(0, (column | 0) - 1);
  const start = Math.max(0, c - CFG.SNIPPET_BEFORE);
  const end = Math.min(raw.length, c + CFG.SNIPPET_AFTER);
  return (start > 0 ? "…" : "") + raw.slice(start, end).trim() + (end < raw.length ? "…" : "");
}

async function resolveSnippet(evidence) {
  if (!evidence || typeof evidence.file !== "string" || !(evidence.line > 0)) {
    return { ok: false, reason: "no resolvable node" };
  }
  const src = await getSource(evidence.file);
  if (!src.ok) return { ok: false, reason: "source unavailable (" + src.reason + ")" };
  const raw = src.lines[evidence.line - 1];
  if (raw === undefined) return { ok: false, reason: "line " + evidence.line + " beyond end of file" };
  const snippet = windowLine(raw, evidence.column);
  if (!snippet) return { ok: false, reason: "blank line at call site" };
  return { ok: true, snippet };
}

/* ===================================================================== *
 * Detector seam — cyborg's, and optional.
 *
 *   extension/src/detectors/index.js
 *     export function runDetectors(events, ctx)
 *       -> { findings: [...], dropped: [{proposed_mechanism, reason}] }
 *
 * Findings arrive WITHOUT evidence.snippet; this file fills it in. If the
 * module is absent the harness still produces a valid, honest Manifest.
 * ===================================================================== */

let detectorsPromise = null;
function loadDetectors() {
  if (!detectorsPromise) {
    detectorsPromise = import("./detectors/index.js")
      .then((m) => (typeof m.runDetectors === "function" ? m : null))
      .catch(() => null);
  }
  return detectorsPromise;
}

/* ===================================================================== *
 * Manifest assembly — the CONTRACT.md enforcement point
 * ===================================================================== */

function pad(n) { return "f_" + String(n).padStart(3, "0"); }

async function buildManifest(tabId) {
  const st = await getTab(tabId);
  const diagnostics = { detectors: "absent", warnings: [], event_count: 0, truncated: false };

  if (!st) {
    return {
      manifest: { url: "", scanned_at: new Date().toISOString(), findings: [], dropped: [{ proposed_mechanism: "unknown", reason: "no instrumentation data for this tab — reload the page with HOOKPRINT enabled" }] },
      diagnostics
    };
  }

  diagnostics.event_count = st.events.length;
  diagnostics.truncated = st.truncated;

  const ctx = {
    session_id: st.session_id,
    url: st.url,
    t0_epoch_ms: st.t0,
    duration_ms: Date.now() - st.t0,
    truncated: st.truncated
  };

  let raw = { findings: [], dropped: [] };
  const mod = await loadDetectors();
  if (mod) {
    diagnostics.detectors = "loaded";
    try {
      const out = mod.runDetectors(st.events.slice(), ctx);
      if (out && Array.isArray(out.findings)) raw.findings = out.findings;
      if (out && Array.isArray(out.dropped)) raw.dropped = out.dropped;
    } catch (e) {
      diagnostics.detectors = "threw";
      diagnostics.warnings.push("runDetectors threw: " + (e && e.message ? e.message : e));
    }
  } else {
    diagnostics.warnings.push("src/detectors/index.js not present — harness is recording, nothing is classifying");
  }

  const findings = [];
  const dropped = raw.dropped.slice();
  let n = 0;

  for (const f of raw.findings) {
    if (!f || typeof f !== "object") { dropped.push({ proposed_mechanism: "unknown", reason: "malformed finding" }); continue; }

    // Frozen vocabulary. An out-of-set mechanism is a bug, and laundering it
    // into "unknown" would hide the bug, so it is dropped and surfaced.
    if (!MECHANISMS.has(f.mechanism)) {
      dropped.push({ proposed_mechanism: String(f.mechanism || "unknown"), reason: "mechanism not in the frozen set" });
      continue;
    }

    const r = await resolveSnippet(f.evidence);
    if (!r.ok) {
      // CONTRACT.md rule 1, enforced. Not shown, not guessed.
      dropped.push({ proposed_mechanism: f.mechanism, reason: r.reason });
      continue;
    }

    let confidence = f.confidence;
    if (!CONFIDENCES.has(confidence)) {
      diagnostics.warnings.push(`finding "${f.mechanism}" had confidence "${confidence}"; coerced to "low"`);
      confidence = "low";
    }

    const supported = !!(f.action && f.action.supported);
    const action = supported
      ? { supported: true, label: String(f.action.label || "Disable"), action_id: String(f.action.action_id || "") }
      : { supported: false };     // label and action_id MUST be absent — CONTRACT.md

    findings.push({
      id: pad(++n),
      mechanism: f.mechanism,
      display_name: String(f.display_name || f.mechanism),
      confidence,
      evidence: {
        file: f.evidence.file,
        line: f.evidence.line | 0,
        column: f.evidence.column | 0,
        snippet: r.snippet
      },
      observed: {
        summary: String((f.observed && f.observed.summary) || ""),
        metrics: (f.observed && typeof f.observed.metrics === "object" && f.observed.metrics) || {}
      },
      action
    });
  }

  return {
    manifest: { url: st.url, scanned_at: new Date().toISOString(), findings, dropped },
    diagnostics
  };
}

/* ===================================================================== *
 * Messaging
 * ===================================================================== */

async function activeTabId() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t ? t.id : null;
  } catch (e) { return null; }
}

async function toContent(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (e) { return { ok: false, error: "content script unreachable: " + (e && e.message ? e.message : e) }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  // Fast, frequent, and fire-and-forget: the event pipe.
  if (msg.type === "HP_EVENTS") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId === null) return;
    ingest(tabId, msg.session_id, msg.url, msg.events || []).catch(() => {});
    return;    // no response; bridge does not wait
  }

  (async () => {
    try {
      switch (msg.type) {
        case "HP_GET_MANIFEST": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          if (tabId == null) return sendResponse({ ok: false, error: "no active tab" });
          const out = await buildManifest(tabId);
          return sendResponse({ ok: true, ...out });
        }
        case "HP_GET_EVENTS": {
          // Raw event access, for building and testing detectors against a
          // real page without a fixture.
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          const st = await getTab(tabId);
          if (!st) return sendResponse({ ok: false, error: "no data for tab" });
          const limit = msg.limit || 500;
          return sendResponse({
            ok: true, session_id: st.session_id, url: st.url, t0_epoch_ms: st.t0,
            truncated: st.truncated, total: st.events.length,
            events: msg.all ? st.events : st.events.slice(-limit)
          });
        }
        case "HP_RESOLVE_SNIPPET": {
          const r = await resolveSnippet(msg.evidence);
          return sendResponse(r.ok ? { ok: true, snippet: r.snippet } : { ok: false, error: r.reason });
        }
        case "HP_ARM": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          return sendResponse(await toContent(tabId, { type: "HP_ARM", action_id: msg.action_id }));
        }
        case "HP_DISARM": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          return sendResponse(await toContent(tabId, { type: "HP_DISARM", action_id: msg.action_id, reason: msg.reason }));
        }
        case "HP_PANIC": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          return sendResponse(await toContent(tabId, { type: "HP_PANIC", reason: msg.reason }));
        }
        case "HP_RELEASE": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          return sendResponse(await toContent(tabId, { type: "HP_RELEASE", action_id: msg.action_id }));
        }
        case "HP_STATUS": {
          const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
          const st = await getTab(tabId);
          const bridge = tabId != null ? await toContent(tabId, { type: "HP_BRIDGE_STATUS" }) : null;
          const mod = await loadDetectors();
          return sendResponse({
            ok: true, tab_id: tabId,
            session: st ? { session_id: st.session_id, url: st.url, events: st.events.length, truncated: st.truncated } : null,
            bridge, detectors: mod ? "loaded" : "absent",
            sources_cached: sources.size
          });
        }
        default:
          return sendResponse({ ok: false, error: "unknown message type " + msg.type });
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: "" + (e && e.message ? e.message : e) }); } catch (e2) { /* ignore */ }
    }
  })();

  return true;      // async sendResponse
});
