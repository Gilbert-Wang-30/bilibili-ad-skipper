/* Bilibili Ad Skipper — MV3 service worker. Stateless: fetch proxy for api.bilibili.com, the AI transcript check's
 * model requests (the API key stays here), defaults, per-tab badge. */

importScripts('llm-providers.js');
const LLM = self.BAS_LLM_PROVIDERS;
const LLM_TIMEOUT_MS = 90000;
const LLM_CONFIG_KEY = 'llmConfig';     // chrome.storage.local: provider / model / base URL only (content scripts can read it)
const LLM_SECRET = 'apiKey';            // the key itself: IndexedDB of the extension origin (llm-providers.js)
// Guards against runaway spending on the viewer's key (a buggy loop, or a script on the page forging new videos):
const LLM_MAX_IN_FLIGHT = 2;
const LLM_MAX_PER_HOUR = 60;
const LLM_MAX_PER_DAY = 400;
const LLM_DEDUPE_MS = 10 * 60 * 1000;   // the same prompt again within this window gets the same answer
let llmInFlight = 0;
const llmRecent = new Map();            // prompt hash → {at, promise}

const DEFAULT_SETTINGS = {
  enabled: true, mode: 'auto', minConfidence: 0.6,
  useChapters: true, useDanmaku: true, useMedia: true, useAudio: false, useHeat: true, useCrowd: true, useSubtitles: true, useLlm: true, useAvProbe: true, skipHereMedia: false, skipHereButton: true,
  showMarkers: true, showToast: true, toastDurationMs: 6000, landingOffsetSec: 0,
  extraStartKeywords: [], extraEndKeywords: [], ignoreUps: [], debug: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    else {
      const next = Object.assign({}, DEFAULT_SETTINGS, settings);
      if (settings.skipHereMedia === undefined && settings.useAvProbe === false) next.skipHereMedia = false;   // keep an A/V opt-out
      await chrome.storage.sync.set({ settings: next });
    }
  } catch (e) { console.warn('[BAS bg] init settings failed', e); }
  try { await chrome.action.setBadgeBackgroundColor({ color: '#fb7299' }); } catch (e) { /* ignore */ }
});

const ALLOWED = /^https:\/\/(?:api\.bilibili\.com\/|bvc\.bilivideo\.com\/pbp\/data\?|bsbsb\.top\/api\/skipSegments\/[0-9a-f]{4}\?)/;
// third-party lookups never carry cookies
const THIRD_PARTY = /^https:\/\/bsbsb\.top\//;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function llmConfig() {
  try {
    const raw = (await chrome.storage.local.get(LLM_CONFIG_KEY))[LLM_CONFIG_KEY];
    if (!raw || typeof raw !== 'object') return null;
    let apiKey = '';
    try { apiKey = (await LLM.getSecret(LLM_SECRET)) || ''; } catch (e) { apiKey = ''; }
    return LLM.normalizeConfig(Object.assign({}, raw, { apiKey }));
  } catch (e) { return null; }
}
function hashText(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return s.length + ':' + h.toString(36); }
/**
 * Hour / day counters, kept in memory and mirrored to chrome.storage.session (which survives the worker being stopped,
 * not a browser restart). Takes run one after another, so simultaneous requests cannot all read the old count.
 */
let llmBudget = null, llmBudgetChain = Promise.resolve();
function llmBudgetTake() {
  const run = llmBudgetChain.then(async () => {
    const now = Date.now();
    if (!llmBudget) { try { llmBudget = (await chrome.storage.session.get('llmBudget')).llmBudget || null; } catch (e) { llmBudget = null; } }
    const b = llmBudget || {};
    if (!b.h || now - b.h >= 3600e3) Object.assign(b, { h: now, hc: 0 });
    if (!b.d || now - b.d >= 86400e3) Object.assign(b, { d: now, dc: 0 });
    llmBudget = b;
    if (b.hc >= LLM_MAX_PER_HOUR) return `已达到每小时 ${LLM_MAX_PER_HOUR} 次 AI 请求的上限（防止意外扣费），稍后自动恢复`;
    if (b.dc >= LLM_MAX_PER_DAY) return `已达到每天 ${LLM_MAX_PER_DAY} 次 AI 请求的上限（防止意外扣费）`;
    b.hc++; b.dc++;
    try { await chrome.storage.session.set({ llmBudget: b }); } catch (e) { /* ignore */ }
    return null;
  });
  llmBudgetChain = run.catch(() => null);
  return run;
}
// a new model, key or address: earlier answers are not reused for it
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[LLM_CONFIG_KEY]) llmRecent.clear(); });

/** One model request: {system, user, schema} → {ok, text, model} | {ok:false, error, timedOut?}. */
async function llmRequest(req) {
  if (!req || typeof req.system !== 'string' || typeof req.user !== 'string') return { ok: false, error: 'bad request' };
  if (req.user.length > LLM.MAX_PROMPT_CHARS) return { ok: false, error: '字幕太长' };
  // the slot is taken before anything is awaited, so simultaneous requests from several tabs cannot all get one
  if (llmInFlight >= LLM_MAX_IN_FLIGHT) return { ok: false, error: 'AI 请求过多，请稍后再试' };
  llmInFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; llmInFlight--; } };
  try {
    const cfg = await llmConfig();
    if (!cfg) return { ok: false, error: '未设置 AI 模型' };
    if (!(await chrome.permissions.contains({ origins: [LLM.originPattern(cfg)] }))) return { ok: false, error: '没有访问 ' + cfg.origin + ' 的权限（请在设置页重新保存 AI 设置）' };
    const key = [cfg.provider, cfg.origin, cfg.model, hashText(cfg.apiKey || ''), hashText(req.system + '\n' + req.user)].join('|');
    for (const [k, v] of llmRecent) if (Date.now() - v.at > LLM_DEDUPE_MS) llmRecent.delete(k);
    const seen = llmRecent.get(key);
    if (seen) { release(); return await seen.promise; }
    const over = await llmBudgetTake();
    if (over) return { ok: false, error: over };
    const promise = llmCall(cfg, req);
    llmRecent.set(key, { at: Date.now(), promise });
    const r = await promise;
    if (!r.ok) llmRecent.delete(key);       // failures may be asked again
    return r;
  } finally { release(); }
}
async function llmCall(cfg, req) {
  const { url, init } = LLM.buildHttp(cfg, req);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
      const resp = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
      let json = null;
      try { json = await resp.json(); } catch (e) { json = null; }
      const r = LLM.parseHttp(cfg, resp.status, json);
      if (r.ok) return { ok: true, text: r.text, model: cfg.model, provider: cfg.provider };
      last = r;
      if (!r.retry || attempt) break;
      // honour the service's own pacing; a long wait is not worth holding the request for
      const ra = Number(resp.headers.get('retry-after'));
      const wait = isFinite(ra) && ra > 0 ? ra * 1000 : 1500;
      if (wait > 8000) break;
      await new Promise((res) => setTimeout(res, wait));
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // the service may still finish (and bill) the first attempt: do not send the same prompt again
        last = { ok: false, error: '模型服务超时', timedOut: true };
        break;
      }
      last = { ok: false, error: '无法连接模型服务：' + String((e && e.message) || e).slice(0, 120) };
      if (attempt) break;
      await new Promise((res) => setTimeout(res, 1500));
    } finally { clearTimeout(timer); }
  }
  return { ok: false, error: (last && last.error) || '模型请求失败', timedOut: !!(last && last.timedOut) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'BAS_FETCH') {
    (async () => {
      try {
        if (!ALLOWED.test(msg.url)) { sendResponse({ ok: false, error: 'url not allowed' }); return; }
        const third = THIRD_PARTY.test(msg.url);
        const init = third
          ? { credentials: 'omit', cache: 'no-store', headers: { 'x-ext-version': 'bilibili-ad-skipper/' + chrome.runtime.getManifest().version } }
          : { credentials: 'include', cache: 'no-store' };
        const resp = await fetch(msg.url, init);
        if (msg.responseType === 'arraybuffer') {
          const buf = await resp.arrayBuffer();
          sendResponse({ ok: resp.ok, status: resp.status, b64: bufToB64(buf) });
        } else {
          const text = await resp.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* not json */ }
          sendResponse({ ok: resp.ok, status: resp.status, json, text: json ? undefined : text.slice(0, 2000) });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  if (msg.type === 'BAS_LLM_STATUS') {
    (async () => {
      const cfg = await llmConfig();
      let permitted = false;
      if (cfg) { try { permitted = await chrome.permissions.contains({ origins: [LLM.originPattern(cfg)] }); } catch (e) { permitted = false; } }
      sendResponse({ ok: true, configured: !!cfg && permitted, provider: cfg ? cfg.provider : null, model: cfg ? cfg.model : null, label: cfg ? cfg.label : null, missingPermission: !!cfg && !permitted });
    })();
    return true;
  }

  if (msg.type === 'BAS_LLM') {
    (async () => {
      try { sendResponse(await llmRequest(msg.request)); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 300) }); }
    })();
    return true;
  }

  if (msg.type === 'BAS_PING') {
    // the content script checks that the running manifest matches its files (an unpacked extension that was updated
    // but not reloaded runs new files under the old manifest) and that the crowd lookup is allowed
    (async () => {
      let crowd = null;
      try { crowd = await chrome.permissions.contains({ origins: ['https://bsbsb.top/*'] }); } catch (e) { crowd = null; }
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, crowdPermission: crowd });
    })();
    return true;
  }

  if (msg.type === 'BAS_BADGE') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      const n = Number(msg.count) || 0;
      chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#fb7299' }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'BAS_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
