/* Bilibili Ad Skipper — storage layer (settings, per-video overrides, result cache, wbi keys).
 * No DOM / chrome.* access at load time. chrome.storage is referenced lazily inside functions and
 * guarded by `typeof chrome !== 'undefined'`; when it is missing (Deno tests, invalidated extension
 * context) an in-memory Map fallback is used so every call still resolves. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) throw new Error('[BAS] 00-ns.js must be loaded before 10-storage.js');

  const SETTINGS_KEY = 'settings';
  const WBI_KEY = 'wbiKeys';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h
  const CACHE_MAX = 300;                      // keep at most this many `c:` entries (LRU by ts)
  const WBI_TTL_MS = 6 * 60 * 60 * 1000;      // 6 h
  const PRUNE_EVERY = 20;                     // run the (expensive) prune every N setCache calls

  const cacheKey = (cid) => `c:${cid}`;
  const overrideKey = (bvid, cid) => `v:${bvid}:${cid}`;

  // ---------- in-memory fallback (mimics the subset of chrome.storage we use) ----------
  const memListeners = new Set();
  function makeMemArea(name) {
    const data = new Map();
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const emit = (changes) => {
      if (!Object.keys(changes).length) return;
      for (const fn of Array.from(memListeners)) { try { fn(changes, name); } catch (e) { BAS.warn('storage listener error', e); } }
    };
    return {
      get(keys) {
        const out = {};
        if (keys == null) { for (const [k, v] of data) out[k] = clone(v); }
        else if (typeof keys === 'string') { if (data.has(keys)) out[keys] = clone(data.get(keys)); }
        else if (Array.isArray(keys)) { for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k)); }
        else if (typeof keys === 'object') { for (const k of Object.keys(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(keys[k]); }
        return Promise.resolve(out);
      },
      set(obj) {
        const changes = {};
        for (const k of Object.keys(obj || {})) {
          if (obj[k] === undefined) continue;
          changes[k] = { oldValue: clone(data.get(k)), newValue: clone(obj[k]) };
          data.set(k, clone(obj[k]));
        }
        emit(changes);
        return Promise.resolve();
      },
      remove(keys) {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
        const changes = {};
        for (const k of list) if (data.has(k)) { changes[k] = { oldValue: clone(data.get(k)) }; data.delete(k); }
        emit(changes);
        return Promise.resolve();
      },
      clear() { const changes = {}; for (const [k, v] of data) changes[k] = { oldValue: clone(v) }; data.clear(); emit(changes); return Promise.resolve(); },
    };
  }
  const mem = { sync: makeMemArea('sync'), local: makeMemArea('local') };

  // ---------- area access ----------
  function chromeArea(name) {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage[name]) return chrome.storage[name];
    } catch (_) { /* accessing chrome.* can throw when the extension context was invalidated */ }
    return null;
  }
  const isPersistent = () => !!chromeArea('local');

  /** Calls a chrome.storage method supporting both callback- and promise-style implementations. */
  function callChrome(areaObj, method, arg) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        const ret = areaObj[method](arg, (value) => {
          let err = null;
          try { err = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.lastError : null; } catch (_) { err = null; }
          if (err) done(reject, new Error(err.message || String(err)));
          else done(resolve, value);
        });
        if (ret && typeof ret.then === 'function') ret.then((v) => done(resolve, v), (e) => done(reject, e));
      } catch (e) { done(reject, e); }
    });
  }

  async function get(area, keys) {
    const c = chromeArea(area);
    if (c) {
      try { return (await callChrome(c, 'get', keys == null ? null : keys)) || {}; }
      catch (e) { BAS.warn('storage.get failed, using memory fallback', area, e && e.message); }
    }
    return mem[area].get(keys);
  }
  async function set(area, obj) {
    const c = chromeArea(area);
    if (c) {
      try { await callChrome(c, 'set', obj); return; }
      catch (e) { BAS.warn('storage.set failed, using memory fallback', area, e && e.message); }
    }
    await mem[area].set(obj);
  }
  async function remove(area, keys) {
    const c = chromeArea(area);
    if (c) {
      try { await callChrome(c, 'remove', keys); return; }
      catch (e) { BAS.warn('storage.remove failed, using memory fallback', area, e && e.message); }
    }
    await mem[area].remove(keys);
  }

  /** Subscribe to changes of either backend. Returns an unsubscribe function. */
  function onChanged(fn) {
    let chromeFn = null;
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged) {
        chromeFn = (changes, area) => { try { fn(changes, area); } catch (e) { BAS.warn('storage listener error', e); } };
        chrome.storage.onChanged.addListener(chromeFn);
      }
    } catch (_) { chromeFn = null; }
    memListeners.add(fn);
    return () => {
      memListeners.delete(fn);
      if (chromeFn) { try { chrome.storage.onChanged.removeListener(chromeFn); } catch (_) { /* ignore */ } }
    };
  }

  // ---------- settings ----------
  const DEFAULTS = BAS.DEFAULT_SETTINGS;
  const toStrList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const toIdList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : String(x).trim())).filter((x) => x !== '' && x != null) : []);

  /** Coerce a stored object into a valid settings object (unknown keys are preserved). */
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    for (const k of Object.keys(DEFAULTS)) {
      const def = DEFAULTS[k], v = s[k];
      if (typeof def === 'boolean') s[k] = typeof v === 'boolean' ? v : def;
      else if (typeof def === 'number') s[k] = typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : def);
      else if (Array.isArray(def)) s[k] = k === 'ignoreUps' ? toIdList(v) : toStrList(v);
      else if (typeof def === 'string') s[k] = typeof v === 'string' ? v : def;
    }
    if (s.mode !== 'auto' && s.mode !== 'manual') s.mode = DEFAULTS.mode;
    s.minConfidence = BAS.util.clamp(s.minConfidence, 0, 1);
    s.toastDurationMs = BAS.util.clamp(s.toastDurationMs, 1000, 60000);
    s.landingOffsetSec = BAS.util.clamp(s.landingOffsetSec, -10, 10);
    return s;
  }

  async function loadSettings() {
    let stored = null;
    try { stored = (await get('sync', SETTINGS_KEY))[SETTINGS_KEY]; } catch (e) { BAS.warn('loadSettings failed', e); }
    const merged = sanitizeSettings(stored);
    BAS.state.settings = merged;
    return merged;
  }

  async function saveSettings(partial) {
    if (!partial || typeof partial !== 'object') return BAS.state.settings;
    let stored = null;
    try { stored = (await get('sync', SETTINGS_KEY))[SETTINGS_KEY]; } catch (_) { /* fall through */ }
    const next = sanitizeSettings(Object.assign({}, stored || {}, partial));
    BAS.state.settings = next;
    await set('sync', { [SETTINGS_KEY]: next });
    return next;
  }

  async function resetSettings() {
    const next = Object.assign({}, DEFAULTS);
    BAS.state.settings = next;
    await set('sync', { [SETTINGS_KEY]: next });
    return next;
  }

  /** fn(mergedSettings, changesObject) — fires on every settings write (also from popup/options). */
  function onSettingsChanged(fn) {
    return onChanged((changes, area) => {
      if (area !== 'sync' || !changes || !changes[SETTINGS_KEY]) return;
      const merged = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      BAS.state.settings = merged;
      fn(merged, changes[SETTINGS_KEY]);
    });
  }

  // ---------- per-video overrides ----------
  const emptyOverrides = () => ({ ignore: [], add: [], ts: 0 });
  function normRange(a, b) {
    const r = a && typeof a === 'object' ? a : { start: a, end: b };
    const start = Number(r.start), end = Number(r.end);
    if (!isFinite(start) || !isFinite(end) || end <= start || start < 0) return null;
    return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
  }
  const sameRange = (x, y) => Math.abs(x.start - y.start) < 0.5 && Math.abs(x.end - y.end) < 0.5;
  function cleanOverrides(raw) {
    const o = emptyOverrides();
    if (raw && typeof raw === 'object') {
      for (const k of ['ignore', 'add']) if (Array.isArray(raw[k])) o[k] = raw[k].map((r) => normRange(r)).filter(Boolean);
      o.ts = typeof raw.ts === 'number' ? raw.ts : 0;
    }
    return o;
  }

  async function getOverrides(bvid, cid) {
    const key = overrideKey(bvid, cid);
    try { return cleanOverrides((await get('local', key))[key]); }
    catch (e) { BAS.warn('getOverrides failed', e); return emptyOverrides(); }
  }
  async function addRange(kind, bvid, cid, a, b) {
    const range = normRange(a, b);
    const cur = await getOverrides(bvid, cid);
    if (!range) { BAS.warn('invalid override range', a, b); return cur; }
    if (!cur[kind].some((r) => sameRange(r, range))) cur[kind].push(range);
    // A manual "add" cancels an identical "ignore" and vice versa.
    const other = kind === 'ignore' ? 'add' : 'ignore';
    cur[other] = cur[other].filter((r) => !sameRange(r, range));
    cur.ts = Date.now();
    await set('local', { [overrideKey(bvid, cid)]: cur });
    return cur;
  }
  /** addIgnore(bvid, cid, {start,end}) or addIgnore(bvid, cid, start, end) */
  const addIgnore = (bvid, cid, a, b) => addRange('ignore', bvid, cid, a, b);
  /** addUser(bvid, cid, {start,end}) or addUser(bvid, cid, start, end) — user-added segment */
  const addUser = (bvid, cid, a, b) => addRange('add', bvid, cid, a, b);
  /** Remove every ignore range that covers most of {start,end} (restores a segment the user ignored/undid). */
  async function removeIgnore(bvid, cid, a, b) {
    const range = normRange(a, b);
    const cur = await getOverrides(bvid, cid);
    if (!range) return cur;
    const ov = (x, y) => Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
    const before = cur.ignore.length;
    cur.ignore = cur.ignore.filter((r) => {
      const o = ov(r, range);
      return !(o > 0.5 * (range.end - range.start) || o > 0.5 * (r.end - r.start));
    });
    if (cur.ignore.length !== before) {
      cur.ts = Date.now();
      await set('local', { [overrideKey(bvid, cid)]: cur });
    }
    return cur;
  }
  async function clearOverrides(bvid, cid) { await remove('local', overrideKey(bvid, cid)); }
  async function clearAllOverrides() {
    const all = await get('local', null);
    const keys = Object.keys(all).filter((k) => k.startsWith('v:'));
    if (keys.length) await remove('local', keys);
    return keys.length;
  }

  // ---------- result cache ----------
  async function getCache(cid, opts) {
    const key = cacheKey(cid);
    try {
      const entry = (await get('local', key))[key];
      if (!entry || typeof entry !== 'object') return null;
      const fresh = typeof entry.ts === 'number' && Date.now() - entry.ts < CACHE_TTL_MS;
      const sameVersion = entry.version === BAS.VERSION;
      if (!fresh || (!sameVersion && !(opts && opts.anyVersion))) {
        remove('local', key).catch(() => {});
        return null;
      }
      return entry;
    } catch (e) { BAS.warn('getCache failed', e); return null; }
  }

  let setCacheCount = 0;
  async function setCache(cid, data) {
    // Extra serialisable fields passed by the orchestrator (boundaries, viewPoints, stats …) are kept as-is.
    const extra = data && typeof data === 'object' ? data : {};
    const entry = Object.assign({}, extra, {
      segments: Array.isArray(data && data.segments) ? data.segments : [],
      candidates: Array.isArray(data && data.candidates) ? data.candidates : [],
      ts: Date.now(),
      version: BAS.VERSION,
    });
    try { await set('local', { [cacheKey(cid)]: entry }); } catch (e) { BAS.warn('setCache failed', e); }
    if (setCacheCount++ % PRUNE_EVERY === 0) maybePrune().catch((e) => BAS.debug('pruneCache failed', e));
    return entry;
  }

  // The full prune reads all of chrome.storage.local; every page load would otherwise pay for it on its first
  // setCache. Run it at most every PRUNE_INTERVAL_MS across page loads (timestamp kept in storage).
  const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  async function maybePrune() {
    let last = 0;
    try { last = Number((await get('local', 'pruneTs')).pruneTs) || 0; } catch (e) { last = 0; }
    if (Date.now() - last < PRUNE_INTERVAL_MS) return 0;
    try { await set('local', { pruneTs: Date.now() }); } catch (e) { /* ignore */ }
    return pruneCache();
  }

  /** Remove expired cache entries and keep at most CACHE_MAX (LRU by ts). Returns number removed. */
  async function pruneCache(max = CACHE_MAX) {
    const all = await get('local', null);
    const now = Date.now();
    const live = [];
    const drop = [];
    for (const k of Object.keys(all)) {
      if (!k.startsWith('c:')) continue;
      const e = all[k];
      const ts = e && typeof e.ts === 'number' ? e.ts : 0;
      if (!e || now - ts >= CACHE_TTL_MS || e.version !== BAS.VERSION) drop.push(k);
      else live.push([k, ts]);
    }
    if (live.length > max) {
      live.sort((a, b) => a[1] - b[1]);            // oldest first
      for (const [k] of live.slice(0, live.length - max)) drop.push(k);
    }
    if (drop.length) await remove('local', drop);
    return drop.length;
  }
  async function clearCache() {
    const all = await get('local', null);
    const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
    if (keys.length) await remove('local', keys);
    return keys.length;
  }

  // ---------- wbi keys ----------
  async function getWbiKeys() {
    try {
      const v = (await get('local', WBI_KEY))[WBI_KEY];
      if (!v || typeof v.imgKey !== 'string' || typeof v.subKey !== 'string') return null;
      if (typeof v.ts !== 'number' || Date.now() - v.ts >= WBI_TTL_MS) return null;
      return { imgKey: v.imgKey, subKey: v.subKey, ts: v.ts };
    } catch (e) { BAS.warn('getWbiKeys failed', e); return null; }
  }
  async function setWbiKeys(keys) {
    if (!keys || typeof keys.imgKey !== 'string' || typeof keys.subKey !== 'string') return;
    await set('local', { [WBI_KEY]: { imgKey: keys.imgKey, subKey: keys.subKey, ts: typeof keys.ts === 'number' ? keys.ts : Date.now() } });
  }

  // ---------- export / import (options page) ----------
  async function exportData() {
    const sync = await get('sync', SETTINGS_KEY);
    const local = await get('local', null);
    const overrides = {};
    for (const k of Object.keys(local)) if (k.startsWith('v:')) overrides[k] = local[k];
    return { version: BAS.VERSION, exportedAt: Date.now(), settings: sanitizeSettings(sync[SETTINGS_KEY]), overrides };
  }
  async function importData(obj) {
    if (!obj || typeof obj !== 'object') throw new TypeError('导入数据格式无效');
    if (obj.settings && typeof obj.settings === 'object') await saveSettings(obj.settings);
    if (obj.overrides && typeof obj.overrides === 'object') {
      const batch = {};
      for (const k of Object.keys(obj.overrides)) if (/^v:[^:]+:\d+$/.test(k)) batch[k] = cleanOverrides(obj.overrides[k]);
      if (Object.keys(batch).length) await set('local', batch);
    }
  }

  BAS.storage = {
    SETTINGS_KEY, WBI_KEY, CACHE_TTL_MS, CACHE_MAX, WBI_TTL_MS,
    cacheKey, overrideKey, isPersistent,
    get, set, remove, onChanged,
    sanitizeSettings, loadSettings, saveSettings, resetSettings, onSettingsChanged,
    getOverrides, addIgnore, addUser, removeIgnore, clearOverrides, clearAllOverrides,
    getCache, setCache, pruneCache, clearCache,
    getWbiKeys, setWbiKeys,
    exportData, importData,
    /** test hook: reset the in-memory fallback */
    __resetMemory() { mem.sync.clear(); mem.local.clear(); setCacheCount = 0; },
  };
})();
