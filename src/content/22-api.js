/* Bilibili Ad Skipper — API layer. No DOM / chrome.* access at load time.
 * Every request first tries a direct page-origin `fetch(url, {credentials:'include'})` (api.bilibili.com
 * reflects *.bilibili.com origins with credentials). When that throws (network/CORS), returns HTTP 412, or
 * returns any other non-OK status while the extension runtime is reachable, the request is retried through
 * the background proxy: chrome.runtime.sendMessage({type:'BAS_FETCH', url, responseType}). */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) throw new Error('[BAS] 00-ns.js must be loaded before 22-api.js');

  const API = 'https://api.bilibili.com';
  const SEGMENT_SEC = 360;
  const MAX_SEGMENTS = 200;          // 20 h safety cap
  const DM_CONCURRENCY = 3;
  const JSON_TIMEOUT_MS = 20000;
  const BUFFER_TIMEOUT_MS = 30000;
  const RETRY_DELAY_MS = 400;

  class ApiError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'ApiError';
      this.status = info && typeof info.status === 'number' ? info.status : 0;
      this.code = info && typeof info.code === 'number' ? info.code : undefined;
      this.url = info && info.url || '';
      if (info && info.cause) this.cause = info.cause;
    }
  }
  function abortError() {
    const e = new Error('请求已取消');
    e.name = 'AbortError';
    return e;
  }
  const isAbort = (e) => !!e && e.name === 'AbortError';

  function canProxy() {
    try { return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function' && !!chrome.runtime.id; }
    catch (_) { return false; }
  }

  function buildUrl(path, params) {
    const u = new URL(path.startsWith('http') ? path : API + path);
    for (const k of Object.keys(params || {})) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  function b64ToBuffer(b64) {
    if (typeof b64 !== 'string') return new ArrayBuffer(0);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  /** Combine the caller's signal with a timeout. Returns {signal, cleanup}. */
  function withTimeout(signal, ms) {
    if (typeof AbortController === 'undefined') return { signal, cleanup() {} };
    const ctrl = new AbortController();
    const onAbort = () => { try { ctrl.abort(); } catch (_) { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(onAbort, ms);
    return {
      signal: ctrl.signal,
      cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); },
    };
  }

  // ---------- background proxy ----------
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        const ret = chrome.runtime.sendMessage(msg, (resp) => {
          let err = null;
          try { err = chrome.runtime.lastError; } catch (_) { err = null; }
          if (err) done(reject, new Error(err.message || String(err)));
          else done(resolve, resp);
        });
        if (ret && typeof ret.then === 'function') ret.then((v) => done(resolve, v), (e) => done(reject, e));
      } catch (e) { done(reject, e); }
    });
  }
  async function proxyFetch(url, responseType, signal) {
    const resp = await sendMessage({ type: 'BAS_FETCH', url, responseType });
    if (signal && signal.aborted) throw abortError();
    if (!resp || typeof resp !== 'object') throw new ApiError('后台代理无响应', { url });
    const status = typeof resp.status === 'number' ? resp.status : 0;
    if (responseType === 'arraybuffer' && status === 304) return new ArrayBuffer(0);
    if (!resp.ok) throw new ApiError(`后台代理请求失败（HTTP ${status}）${resp.error ? '：' + resp.error : ''}`, { status, url });
    if (responseType === 'json') {
      if (resp.json === undefined || resp.json === null) throw new ApiError('后台代理返回空响应', { status, url });
      return resp.json;
    }
    return b64ToBuffer(resp.b64);
  }

  // ---------- core request with fallback ----------
  async function request(url, responseType, opts) {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) throw abortError();
    const timeoutMs = opts && opts.timeoutMs || (responseType === 'json' ? JSON_TIMEOUT_MS : BUFFER_TIMEOUT_MS);
    const { signal: sig, cleanup } = withTimeout(signal, timeoutMs);
    let directErr = null, parseErr = null;
    try {
      const res = await fetch(url, { credentials: (opts && opts.credentials) || 'include', signal: sig });
      if (res.status === 304 && responseType === 'arraybuffer') return new ArrayBuffer(0);
      if (res.ok) {
        if (responseType !== 'json') return await res.arrayBuffer();
        // A 200 with a non-JSON body is a definitive answer (not a transport problem) → no proxy retry.
        try { return await res.json(); }
        catch (e) { parseErr = new ApiError('响应不是有效的 JSON', { status: res.status, url, cause: e }); }
      } else {
        directErr = new ApiError(`请求失败（HTTP ${res.status}）`, { status: res.status, url });
      }
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      directErr = isAbort(e) ? new ApiError('请求超时', { url, cause: e }) : e;
    } finally { cleanup(); }
    if (parseErr) throw parseErr;
    if (signal && signal.aborted) throw abortError();

    // Fallback policy: proxy on network/CORS error, HTTP 412, or any non-OK status while the runtime is reachable.
    if (!canProxy()) throw directErr;
    BAS.debug('api: direct fetch failed, using background proxy', url, directErr && directErr.message);
    try {
      return await proxyFetch(url, responseType, signal);
    } catch (e2) {
      if (isAbort(e2)) throw e2;
      const err = new ApiError(`请求失败：${directErr && directErr.message || '未知错误'}；${e2 && e2.message || e2}`, {
        status: (e2 && e2.status) || (directErr && directErr.status) || 0, url, cause: e2,
      });
      err.direct = directErr;
      throw err;
    }
  }
  /** GET JSON (full envelope {code,message,data}). */
  const fetchJSON = (url, opts) => request(url, 'json', opts);
  /** GET binary. Resolves to an empty ArrayBuffer for HTTP 304 (bilibili's "no such segment"). */
  const fetchBuffer = (url, opts) => request(url, 'arraybuffer', opts);

  // ---------- view ----------
  function normalizeView(d) {
    const pages = Array.isArray(d.pages) ? d.pages.map((p, i) => ({
      cid: Number(p.cid), part: String(p.part == null ? '' : p.part), duration: Number(p.duration) || 0, page: Number(p.page) || i + 1,
    })) : [];
    return {
      aid: Number(d.aid), bvid: String(d.bvid || ''), cid: Number(d.cid), duration: Number(d.duration) || 0,
      title: String(d.title || ''), owner: { mid: d.owner ? d.owner.mid : undefined, name: d.owner ? String(d.owner.name || '') : '' },
      pages,
    };
  }
  /** getView({bvid}) | getView({aid}) → {aid,bvid,cid,duration,title,owner:{mid,name},pages:[{cid,part,duration,page}]} */
  async function getView(id, opts) {
    const params = {};
    if (id && id.bvid) params.bvid = id.bvid;
    else if (id && (id.aid || id.aid === 0)) params.aid = id.aid;
    else throw new TypeError('getView 需要 bvid 或 aid');
    let json = null, lastErr = null;
    try {
      json = await fetchJSON(buildUrl('/x/web-interface/view', params), opts);
    } catch (e) { if (isAbort(e)) throw e; lastErr = e; }
    const riskControlled = !json || BAS.wbi.needsRefresh(json) || json.code === -412 || json.code === -401 || json.code === -509 || json.code === -799;
    if (riskControlled) {
      // Plain `view` may be risk-controlled (412 / -352 / v_voucher); retry with the signed endpoint.
      try {
        const url = await BAS.wbi.signedUrl(API + '/x/web-interface/wbi/view', params, { signal: opts && opts.signal });
        const j2 = await fetchJSON(url, opts);
        if (j2 && j2.code === 0 && j2.data) json = j2;
        else if (j2 && !json) json = j2;
      } catch (e) { if (isAbort(e)) throw e; lastErr = lastErr || e; }
    }
    if (!json) throw lastErr || new ApiError('视频信息获取失败', {});
    if (json.code !== 0 || !json.data) throw new ApiError(`视频信息获取失败（${json.code}）${json.message || ''}`, { code: json.code });
    return normalizeView(json.data);
  }

  // ---------- player info (chapters) ----------
  function normalizeViewPoints(vp) {
    if (!Array.isArray(vp)) return [];
    const out = [];
    for (const v of vp) {
      if (!v || typeof v !== 'object') continue;
      const from = Number(v.from), to = Number(v.to);
      if (!isFinite(from) || !isFinite(to)) continue;
      out.push({ type: Number(v.type) || 0, from, to, content: String(v.content == null ? '' : v.content), imgUrl: v.imgUrl || '', logoUrl: v.logoUrl || '' });
    }
    return out;
  }
  /** getPlayerInfo(aid, cid) → {view_points: ViewPoint[], aid, cid, raw} — wbi/v2 unsigned → signed → legacy v2. */
  async function getPlayerInfo(aid, cid, opts) {
    const params = { aid, cid };
    const attempts = [
      () => fetchJSON(buildUrl('/x/player/wbi/v2', params), opts),
      async () => {
        const url = await BAS.wbi.signedUrl(API + '/x/player/wbi/v2', params, { signal: opts && opts.signal });
        const j = await fetchJSON(url, opts);
        if (BAS.wbi.needsRefresh(j)) {
          const url2 = await BAS.wbi.signedUrl(API + '/x/player/wbi/v2', params, { force: true, signal: opts && opts.signal });
          return fetchJSON(url2, opts);
        }
        return j;
      },
      () => fetchJSON(buildUrl('/x/player/v2', params), opts),
    ];
    let lastErr = null, lastJson = null;
    for (const attempt of attempts) {
      if (opts && opts.signal && opts.signal.aborted) throw abortError();
      try {
        const json = await attempt();
        if (json && json.code === 0 && json.data) {
          return { aid: Number(json.data.aid) || Number(aid), cid: Number(json.data.cid) || Number(cid), view_points: normalizeViewPoints(json.data.view_points), raw: json.data };
        }
        lastJson = json;
        BAS.debug('getPlayerInfo: attempt returned code', json && json.code, json && json.message);
      } catch (e) {
        if (isAbort(e)) throw e;
        lastErr = e;
        BAS.debug('getPlayerInfo: attempt failed', e && e.message);
      }
    }
    if (lastJson) throw new ApiError(`播放器信息获取失败（${lastJson.code}）${lastJson.message || ''}`, { code: lastJson.code });
    throw lastErr || new ApiError('播放器信息获取失败', {});
  }

  // ---------- danmaku ----------
  function segmentUrl(aid, cid, index) {
    return buildUrl('/x/v2/dm/web/seg.so', { type: 1, oid: cid, pid: aid, segment_index: index });
  }
  /** Run `worker(index)` for 1..count with bounded concurrency; `shouldStop(index)` can end early. */
  async function runPool(count, concurrency, worker, shouldStop) {
    let next = 1;
    const lanes = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) {
      lanes.push((async () => {
        for (;;) {
          const idx = next++;
          if (idx > count || (shouldStop && shouldStop(idx))) return;
          await worker(idx);
        }
      })());
    }
    await Promise.all(lanes);
  }

  /**
   * Fetch and decode all danmaku segments for a video part.
   * @param {number} aid
   * @param {number} cid
   * @param {number} duration seconds (segments 1..ceil(duration/360)); when unknown, probes until an empty segment
   * @param {{onSegment?:(index:number, list:object[], info:{preloaded:boolean})=>void, preloaded?:Map<number,object[]>|object, signal?:AbortSignal}} [opts]
   * @returns {Promise<object[] & {missingSegments:number[], segmentCount:number}>} Danmaku[] sorted by t
   */
  async function getDanmaku(aid, cid, duration, opts) {
    opts = opts || {};
    const signal = opts.signal;
    const knownCount = isFinite(duration) && duration > 0 ? Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(duration / SEGMENT_SEC))) : 0;
    const count = knownCount || MAX_SEGMENTS;
    const preloaded = opts.preloaded;
    const getPre = (i) => {
      if (!preloaded) return null;
      let v = null;
      try { v = typeof preloaded.get === 'function' ? preloaded.get(i) : preloaded[i]; } catch (_) { v = null; }
      return Array.isArray(v) ? v : null;
    };
    const parts = new Map();
    const missing = [];
    let endReached = Infinity;        // only used when the segment count is unknown

    const emit = (idx, list, pre) => {
      if (typeof opts.onSegment === 'function') { try { opts.onSegment(idx, list, { preloaded: pre }); } catch (e) { BAS.warn('onSegment handler error', e); } }
    };
    async function fetchSegment(idx) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) throw abortError();
        try {
          const buf = await fetchBuffer(segmentUrl(aid, cid, idx), { signal });
          return BAS.decodeDmSeg(buf);
        } catch (e) {
          if (isAbort(e)) throw e;
          lastErr = e;
          BAS.debug(`danmaku segment ${idx} attempt ${attempt + 1} failed`, e && e.message);
          if (e && e.status === 412) break;               // risk control: retrying only makes it worse
          if (attempt === 0) await BAS.util.sleep(RETRY_DELAY_MS);
        }
      }
      throw lastErr;
    }
    let blocked = false;              // circuit breaker: stop hammering the API once it answers 412 (risk control)
    await runPool(count, DM_CONCURRENCY, async (idx) => {
      if (idx >= endReached) return;
      const pre = getPre(idx);
      if (pre) { parts.set(idx, pre); emit(idx, pre, true); return; }
      if (blocked) { missing.push(idx); return; }
      try {
        const list = await fetchSegment(idx);
        if (!list.length && !knownCount) { endReached = Math.min(endReached, idx); return; }   // 304 / empty body → no more segments
        parts.set(idx, list);
        emit(idx, list, false);
      } catch (e) {
        if (isAbort(e)) throw e;
        missing.push(idx);
        if (e && e.status === 412) blocked = true;
        BAS.warn(`弹幕分段 ${idx} 加载失败`, e && e.message);
      }
    }, (idx) => idx >= endReached);

    const result = [];
    const indices = Array.from(parts.keys()).sort((a, b) => a - b);
    for (const i of indices) for (const d of parts.get(i)) result.push(d);
    result.sort((a, b) => a.t - b.t);
    const segmentCount = knownCount || (isFinite(endReached) ? endReached - 1 : indices.length);
    result.missingSegments = missing.filter((i) => i <= segmentCount).sort((a, b) => a - b);
    result.segmentCount = segmentCount;
    return result;
  }

  /**
   * getHeat(aid, cid, bvid) → raw 高能进度条 JSON from bvc.bilivideo.com, or null when unavailable.
   * Served without cookies; the endpoint only answers CORS requests that carry r=loader (as the player does).
   */
  async function getHeat(aid, cid, bvid, opts) {
    const params = { aid, cid };
    if (bvid) params.bvid = bvid;
    params.r = 'loader';
    try {
      return await fetchJSON(buildUrl('https://bvc.bilivideo.com/pbp/data', params), Object.assign({}, opts, { credentials: 'omit' }));
    } catch (e) {
      if (isAbort(e)) throw e;
      BAS.debug('heat curve unavailable', e && e.message);
      return null;
    }
  }

  /**
   * getCrowdSegments(bvid) → BilibiliSponsorBlock sponsor segments of this video ([] when none). Privacy: only the first
   * 4 hex digits of sha256(bvid) are sent; the server answers with every marked video in that bucket and the match is
   * made here. The server sends no CORS headers, so the request always goes through the background worker, without
   * cookies (src/background.js).
   */
  const CROWD_API = 'https://bsbsb.top/api/skipSegments/';
  const CROWD_TIMEOUT_MS = 5000;     // detection waits for the lookup; a slow third-party server must not hold it up
  async function sha256Hex(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function getCrowdSegments(bvid, opts) {
    if (!bvid || !canProxy()) return [];
    const prefix = (await sha256Hex(bvid)).slice(0, 4);
    const url = CROWD_API + prefix + '?categories=' + encodeURIComponent('["sponsor"]');
    let json, timer = null, onAbort = null;
    const signal = opts && opts.signal;
    const giveUp = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError('众包片段库请求超时', { url })), (opts && opts.timeoutMs) || CROWD_TIMEOUT_MS);
      if (signal) { onAbort = () => reject(abortError()); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    });
    try { json = await Promise.race([proxyFetch(url, 'json', signal), giveUp]); }
    catch (e) {
      if (isAbort(e)) throw e;
      if (e && e.status === 404) return [];          // nothing marked in this bucket
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    const entry = Array.isArray(json) ? json.find((v) => v && v.videoID === bvid) : null;
    return entry && Array.isArray(entry.segments) ? entry.segments.slice(0, 50) : [];
  }

  // ---------- AI subtitles ----------
  // Files the player lists in x/player/wbi/v2 data.subtitle (AI: aisubtitle.hdslb.com, uploader's: i0.hdslb.com).
  const SUBTITLE_URL_RE = /^https:\/\/(?:aisubtitle|i\d)\.hdslb\.com\/bfs\/(?:ai_)?subtitle\//;
  const SUBTITLE_TIMEOUT_MS = 6000;
  const MAX_SUBTITLE_LINES = 20000;
  /**
   * getDmViewSubtitles(aid, cid) → [{lan, url}] — the subtitle list of x/v2/dm/view (JSON), which also answers signed-out
   * viewers (x/player/wbi/v2 lists AI subtitles only to signed-in ones). Undocumented; 46 of 50 sampled videos had ai-zh.
   */
  async function getDmViewSubtitles(aid, cid, opts) {
    const json = await fetchJSON(buildUrl('/x/v2/dm/view', { type: 1, oid: cid, pid: aid }), opts);
    if (!json || json.code !== 0) throw new ApiError(`字幕列表获取失败（${json ? json.code : '无响应'}）`, { code: json && json.code });
    const list = json.data && json.data.subtitle && Array.isArray(json.data.subtitle.subtitles) ? json.data.subtitle.subtitles : [];
    return list.slice(0, 12).map((x) => ({ lan: String((x && x.lan) || '').slice(0, 24), url: String((x && x.subtitle_url) || '').slice(0, 800) })).filter((x) => x.url);
  }
  /** Chinese first (uploader's own track before the AI one), then English. */
  function pickSubtitle(list) {
    const ok = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.url === 'string' && typeof x.lan === 'string');
    const rank = (lan) => {
      const l = lan.toLowerCase();
      if (/^zh/.test(l)) return 0;
      if (/^ai-zh/.test(l)) return 1;
      if (/^(ai-)?en/.test(l)) return 2;
      return 9;
    };
    const best = ok.filter((x) => rank(x.lan) < 9).sort((a, b) => rank(a.lan) - rank(b.lan))[0];
    return best || null;
  }
  /** getSubtitleBody(url) → [{from, to, content}] — one CDN file, fetched like the player does, without cookies. */
  async function getSubtitleBody(url, opts) {
    let u = String(url || '');
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('http://')) u = 'https://' + u.slice(7);
    if (!SUBTITLE_URL_RE.test(u)) throw new ApiError('字幕地址不受支持', { url: u.replace(/\?.*$/, '').slice(0, 120) });
    const t = withTimeout(opts && opts.signal, SUBTITLE_TIMEOUT_MS);
    try {
      const resp = await fetch(u, { credentials: 'omit', cache: 'force-cache', signal: t.signal });
      if (!resp.ok) throw new ApiError(`字幕下载失败（HTTP ${resp.status}）`, { status: resp.status });
      const j = await resp.json();
      const body = j && Array.isArray(j.body) ? j.body.slice(0, MAX_SUBTITLE_LINES) : [];
      const out = [];
      for (const r of body) {
        const from = Number(r && r.from), to = Number(r && r.to);
        if (isFinite(from) && isFinite(to) && to >= from && typeof (r && r.content) === 'string') out.push({ from, to, content: r.content.slice(0, 300) });
      }
      return out;
    } catch (e) {
      if (opts && opts.signal && opts.signal.aborted) throw abortError();
      if (isAbort(e)) throw new ApiError('字幕下载超时', {});
      throw e;
    } finally { t.cleanup(); }
  }

  BAS.api = {
    API, SEGMENT_SEC, DM_CONCURRENCY, ApiError,
    buildUrl, segmentUrl, b64ToBuffer, canProxy,
    fetchJSON, fetchBuffer,
    getView, getPlayerInfo, getDanmaku, getHeat, getCrowdSegments, sha256Hex, pickSubtitle, getSubtitleBody, getDmViewSubtitles,
    getWbiKeys: (opts) => BAS.wbi.getKeys(opts),
  };
})();
