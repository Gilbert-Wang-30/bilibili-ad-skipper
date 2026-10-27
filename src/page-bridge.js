/* Bilibili Ad Skipper — MAIN-world bridge.
 * Runs at document_start inside the page's own JS world. It (1) publishes the current video identity read from
 * window.__INITIAL_STATE__, (2) observes player API responses the page already fetches (chapters, subtitle list,
 * danmaku segments, heat)
 * and forwards them to the isolated-world content script via window.postMessage. It never alters any request/response.
 */
(() => {
  if (window.__BAS_BRIDGE__) return;
  const VERSION = '3.0.0';
  const ORIGIN = location.origin;
  const post = (msg, transfer) => {
    try { window.postMessage(Object.assign({ __bas: true }, msg), ORIGIN, transfer || []); } catch (e) { /* ignore */ }
  };

  // ---------- page state ----------
  let lastKey = '';
  function readState() {
    const st = window.__INITIAL_STATE__;
    if (!st || !st.videoData) return null;
    const vd = st.videoData;
    const p = Number(st.p || new URLSearchParams(location.search).get('p') || 1) || 1;
    const pages = Array.isArray(vd.pages) ? vd.pages.map((pg) => ({ cid: pg.cid, part: pg.part, duration: pg.duration, page: pg.page })) : [];
    const page = pages[p - 1];
    const cid = (page && page.cid) || st.cid || vd.cid;
    const duration = (page && page.duration) || vd.duration;
    const mid = (st.upData && st.upData.mid) || (vd.owner && vd.owner.mid) || null;
    const upName = (st.upData && st.upData.name) || (vd.owner && vd.owner.name) || '';
    return { aid: st.aid || vd.aid, bvid: st.bvid || vd.bvid, cid, p, duration, title: vd.title || document.title, mid: mid != null ? String(mid) : null, upName, pages, href: location.href };
  }
  function publishState(force) {
    const s = readState();
    if (!s || !s.cid) return;
    const key = `${s.bvid}:${s.cid}:${s.p}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    post({ type: 'BAS_PAGE_STATE', state: s });
  }
  const debouncedPublish = (() => { let t = null; return () => { clearTimeout(t); t = setTimeout(() => publishState(false), 200); }; })();

  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        const before = location.href;
        const r = orig.apply(this, arguments);
        try {
          if (location.href !== before) post({ type: 'BAS_URL_CHANGED', href: location.href });
          debouncedPublish();
        } catch (e) {}
        return r;
      };
    };
    wrap('pushState'); wrap('replaceState');
  } catch (e) { /* ignore */ }
  window.addEventListener('popstate', debouncedPublish);
  window.addEventListener('DOMContentLoaded', () => publishState(true));
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__bas) return;
    if (ev.data.type === 'BAS_REQUEST_STATE') {
      publishState(true);
      // the player usually asks for its info before the content script is listening: say it again
      for (const m of playerInfos.values()) post(m);
    }
    if (ev.data.type === 'BAS_PLAYER_SEEK' && typeof ev.data.t === 'number') {
      try { if (window.player && typeof window.player.seek === 'function') window.player.seek(ev.data.t); } catch (e) {}
    }
  });
  // bilibili mutates __INITIAL_STATE__ in place when switching parts; poll cheaply.
  setInterval(() => publishState(false), 1000);
  publishState(true);

  // ---------- response observers ----------
  const PLAYER_RE = /\/x\/player\/(wbi\/)?v2(\?|$)/;
  const DM_RE = /\/x\/v2\/dm\/(wbi\/)?web\/seg\.so(\?|$)/;
  const PBP_RE = /\/\/bvc\.bilivideo\.com\/pbp\/data(\?|$)/;   // 高能进度条 heat curve
  const JSON_RE = { test: (u) => PLAYER_RE.test(u) || PBP_RE.test(u) };

  const playerInfos = new Map();   // cid → last BAS_PLAYER_INFO message
  function subtitleList(data) {
    const list = data && data.subtitle && Array.isArray(data.subtitle.subtitles) ? data.subtitle.subtitles : [];
    return list.slice(0, 12).map((x) => ({ lan: String((x && x.lan) || '').slice(0, 24), url: String((x && x.subtitle_url) || '').slice(0, 800) })).filter((x) => x.url);
  }
  function handleJSON(url, text) {
    if (PBP_RE.test(url)) { handleHeat(url, text); return; }
    if (!PLAYER_RE.test(url)) return;
    try {
      const j = JSON.parse(text);
      if (j && j.code === 0 && j.data) {
        const msg = {
          type: 'BAS_PLAYER_INFO', aid: j.data.aid, cid: j.data.cid, bvid: j.data.bvid,
          view_points: Array.isArray(j.data.view_points) ? j.data.view_points : [],
          // AI subtitles are listed only for signed-in viewers; an unsigned request can list another video's file
          subtitles: subtitleList(j.data), signed: /[?&]w_rid=/.test(url),
        };
        playerInfos.set(String(j.data.cid), msg);
        if (playerInfos.size > 5) playerInfos.delete(playerInfos.keys().next().value);
        post(msg);
      }
    } catch (e) { /* ignore */ }
  }
  function handleBuffer(url, buf) {
    if (!DM_RE.test(url) || !buf) return;
    try {
      const u = new URL(url, location.href);
      const oid = u.searchParams.get('oid');
      const idx = Number(u.searchParams.get('segment_index'));
      if (!oid || !idx) return;
      // Partial windows (pull_mode / ps / pe) are not full 6-minute segments; let the extension fetch those itself.
      if (u.searchParams.has('ps') || u.searchParams.has('pe') || u.searchParams.has('pull_mode')) return;
      if (u.searchParams.get('type') && u.searchParams.get('type') !== '1') return;
      const copy = buf.slice(0); // own copy, transferable
      post({ type: 'BAS_DM_SEG', oid: String(oid), segment_index: idx, buffer: copy }, [copy]);
    } catch (e) { /* ignore */ }
  }
  function handleHeat(url, text) {
    try {
      const cid = new URL(url, location.href).searchParams.get('cid');
      const j = JSON.parse(text);
      const m = j && Array.isArray(j.modules) ? j.modules.find((x) => x && x.params && x.params.data) : null;
      const d = m ? m.params.data : j;
      if (!cid || !d || !d.events || !Array.isArray(d.events.default)) return;
      post({ type: 'BAS_HEAT', cid: String(cid), data: { step_sec: d.step_sec, events: { default: d.events.default.slice(0, 2000) }, debug: typeof d.debug === 'string' ? d.debug.slice(0, 500) : '' } });
    } catch (e) { /* ignore */ }
  }
  function interesting(url) { return typeof url === 'string' && (PLAYER_RE.test(url) || DM_RE.test(url) || PBP_RE.test(url)); }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (interesting(url)) {
            p.then((resp) => {
              try {
                if (!resp || !resp.ok) return;
                const clone = resp.clone();
                if (JSON_RE.test(url)) clone.text().then((t) => handleJSON(url, t)).catch(() => {});
                else clone.arrayBuffer().then((b) => handleBuffer(url, b)).catch(() => {});
              } catch (e) { /* ignore */ }
            }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return p;
      };
    }
  } catch (e) { /* ignore */ }

  try {
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && XHR.open && XHR.send) {
      const origOpen = XHR.open, origSend = XHR.send;
      const xhrUrls = new WeakMap();   // no expando on bilibili's XHR objects
      XHR.open = function (method, url) { try { xhrUrls.set(this, typeof url === 'string' ? url : String(url)); } catch (e) {} return origOpen.apply(this, arguments); };
      XHR.send = function () {
        try {
          const url = xhrUrls.get(this);
          if (interesting(url)) {
            this.addEventListener('load', () => {
              try {
                if (this.status < 200 || this.status >= 300) return;
                const rt = this.responseType;
                if (JSON_RE.test(url)) {
                  if (rt === '' || rt === 'text') handleJSON(url, this.responseText);
                  else if (rt === 'json' && this.response) handleJSON(url, JSON.stringify(this.response));
                } else if (rt === 'arraybuffer' && this.response) {
                  handleBuffer(url, this.response);
                }
              } catch (e) { /* ignore */ }
            });
          }
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) { /* ignore */ }

  window.__BAS_BRIDGE__ = { version: VERSION };
})();
