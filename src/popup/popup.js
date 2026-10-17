/* Bilibili Ad Skipper — popup. Plain script, no inline handlers (MV3 CSP). Talks to the content script
 * of the active tab via chrome.tabs.sendMessage using the SPEC §10.5 protocol. */
(() => {
  'use strict';

  // Copy of BAS.DEFAULT_SETTINGS (popup cannot load 00-ns.js).
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'auto',
    minConfidence: 0.6,
    useChapters: true,
    useDanmaku: true,
    useMedia: true,
    useAudio: false,
    useHeat: true,
    useAvProbe: true,
    skipHereButton: true,
    showMarkers: true,
    showToast: true,
    toastDurationMs: 6000,
    landingOffsetSec: 0,
    extraStartKeywords: [],
    extraEndKeywords: [],
    ignoreUps: [],
    debug: false,
  };

  const REFRESH_MS = 1500;
  const REPLY_TIMEOUT_MS = 2500;
  const VIDEO_URL_RE = /^https:\/\/www\.bilibili\.com\/(video|list|festival)\//;
  const SOURCE_LABEL = { chapter: '章节', danmaku: '弹幕', user: '手动', media: '音视频', heat: '热度' };
  const MARKS_KEY = 'popupMarks';

  // ---------- pure helpers ----------
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  function fmtRange(start, end) {
    return fmtTime(start) + '–' + (end == null ? '?' : fmtTime(end));
  }
  function pct(conf) {
    const n = Number(conf);
    return isFinite(n) ? Math.round(Math.max(0, Math.min(1, n)) * 100) + '%' : '—';
  }
  function sourcesOf(seg) {
    const list = Array.isArray(seg.sources) && seg.sources.length ? seg.sources : (seg.source ? [seg.source] : []);
    return Array.from(new Set(list.filter((s) => SOURCE_LABEL[s])));
  }
  function isVideoUrl(url) { return typeof url === 'string' && VIDEO_URL_RE.test(url); }
  function mergeSettings(stored) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (stored[k] !== undefined) out[k] = stored[k];
    }
    return out;
  }
  /** Text for the status line given a tab/state probe result. */
  function statusText(probe) {
    if (!probe || probe.kind === 'notVideo') return { text: '请在 B 站视频页使用', err: true };
    if (probe.kind === 'noReceiver') return { text: '页面脚本未就绪，请刷新', err: true };
    const st = probe.state || {};
    const n = Array.isArray(st.segments) ? st.segments.filter((x) => x && x.enabled !== false).length : 0;
    switch (st.status) {
      case 'disabled': return { text: '扩展已关闭', err: false };
      case 'ignored': return { text: '已忽略该 UP 主', err: false };
      case 'error': return { text: '检测出错' + (st.error ? '：' + String(st.error).slice(0, 60) : ''), err: true };
      case 'idle':
      case 'loading': return { text: n ? `检测中…（已检测到 ${n} 段广告）` : '检测中…', err: false };
      case 'ready': return { text: n ? `已检测到 ${n} 段广告` : '未检测到广告', err: false };
      default: return { text: n ? `已检测到 ${n} 段广告` : '检测中…', err: false };
    }
  }
  /** Stable key so the list is only re-rendered when something visible changed (keeps hover/click state). */
  function listKey(segments, dropped) {
    const a = (segments || []).map((s) => [s.id, s.enabled ? 1 : 0, s.autoSkip ? 1 : 0, Math.round(s.start), Math.round(s.end), Math.round((s.confidence || 0) * 100)].join(','));
    const b = (dropped || []).map((s) => [Math.round(s.start), s.end == null ? 'n' : Math.round(s.end), Math.round((s.confidence || 0) * 100)].join(','));
    return a.join('|') + '#' + b.join('|');
  }

  // Expose pure helpers for Deno tests when running outside the extension.
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.runtime) {
    globalThis.__BAS_POPUP_TEST__ = { DEFAULT_SETTINGS, fmtTime, fmtRange, pct, sourcesOf, isVideoUrl, mergeSettings, statusText, listKey };
    return;
  }

  // ---------- chrome plumbing ----------
  const $ = (id) => document.getElementById(id);

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return (tabs && tabs[0]) || null;
    } catch (e) { return null; }
  }

  /** Send to the content script; never rejects. Resolves {ok:false, noReceiver:true} when nobody listens. */
  function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout', noReceiver: true }), REPLY_TIMEOUT_MS);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) finish({ ok: false, error: err.message || String(err), noReceiver: true });
          else if (resp == null) finish({ ok: false, error: 'empty reply', noReceiver: true });
          else finish(resp);
        });
      } catch (e) {
        finish({ ok: false, error: String(e && e.message || e), noReceiver: true });
      }
    });
  }

  async function loadSettings() {
    try {
      const r = await chrome.storage.sync.get('settings');
      return mergeSettings(r && r.settings);
    } catch (e) { return mergeSettings(null); }
  }
  async function saveSettings(partial) {
    try {
      const cur = await loadSettings();
      await chrome.storage.sync.set({ settings: Object.assign(cur, partial) });
    } catch (e) { showToast('保存设置失败'); }
  }

  // Pending manual marks survive popup close (storage.session when available, else local).
  const marksArea = (chrome.storage && chrome.storage.session) || chrome.storage.local;
  async function loadMarks() {
    try { const r = await marksArea.get(MARKS_KEY); return (r && r[MARKS_KEY]) || null; } catch (e) { return null; }
  }
  async function saveMarks(m) {
    try { if (m) await marksArea.set({ [MARKS_KEY]: m }); else await marksArea.remove(MARKS_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- UI state ----------
  let tabId = null;
  let settings = mergeSettings(null);
  let lastProbe = null;
  let lastKey = null;
  let marks = null;          // {cid, start, end}
  let timer = null;
  let toastTimer = null;
  let busy = false;

  function showToast(text, ms = 1600) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, cls, onClick, title) {
    const b = el('button', 'btn sm' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(b); });
    return b;
  }

  function renderSettings() {
    $('enabled').checked = !!settings.enabled;
    for (const b of document.querySelectorAll('#modeCtrl .seg-btn')) {
      b.setAttribute('aria-checked', b.dataset.mode === settings.mode ? 'true' : 'false');
    }
  }

  function renderStatus(probe) {
    const st = probe && probe.state;
    const video = st && st.video;
    const titleEl = $('videoTitle');
    const t = video && video.title ? String(video.title) : (probe && probe.tabTitle ? String(probe.tabTitle).replace(/_哔哩哔哩_bilibili$/, '') : '—');
    titleEl.textContent = t;
    titleEl.title = t;
    const s = statusText(probe);
    const stEl = $('status');
    stEl.textContent = s.text;
    stEl.classList.toggle('err', !!s.err);
  }

  function segRow(seg, isDropped) {
    const li = el('li', 'seg-row' + (seg.enabled === false ? ' disabled' : ''));
    const main = el('div', 'seg-main');
    main.appendChild(el('span', 'seg-time', fmtRange(seg.start, seg.end)));
    for (const s of sourcesOf(seg)) main.appendChild(el('span', 'badge ' + s, SOURCE_LABEL[s]));
    if (!isDropped && seg.ignored) main.appendChild(el('span', 'badge low', '已忽略'));
    else if (!isDropped && seg.offerOnly) main.appendChild(el('span', 'badge low', '仅提示'));
    else if (!isDropped && !seg.autoSkip && settings.mode === 'auto') main.appendChild(el('span', 'badge low', '不自动跳'));
    main.appendChild(el('span', 'conf', pct(seg.confidence)));
    li.appendChild(main);

    const actions = el('div', 'seg-actions');
    actions.appendChild(btn('跳到此处', '', () => act({ type: 'BAS_SEEK', t: Math.max(0, Number(seg.start) - 2) }, null), '跳到广告开始前 2 秒'));
    if (isDropped) {
      if (seg.end != null && seg.end > seg.start) {
        actions.appendChild(btn('标为广告', 'primary', () => act({ type: 'BAS_ADD_SEGMENT', start: seg.start, end: seg.end }, '已添加'), '将此候选添加为广告段'));
      }
    } else if (seg.enabled === false) {
      actions.appendChild(btn(seg.ignored ? '恢复' : '启用', 'primary', () => act({ type: 'BAS_SET_SEGMENT_ENABLED', id: seg.id, enabled: true }, seg.ignored ? '已恢复' : '已启用'), seg.ignored ? '取消忽略，恢复跳过此段' : ''));
    } else {
      actions.appendChild(btn('忽略', '', () => act({ type: 'BAS_IGNORE_SEGMENT', id: seg.id }, '已忽略'), '本视频不再跳过此段'));
    }
    li.appendChild(actions);

    if (seg.reason) {
      const r = el('div', 'seg-reason', String(seg.reason));
      r.title = String(seg.reason);
      li.appendChild(r);
    }
    return li;
  }

  function renderLists(probe) {
    const st = probe && probe.kind === 'ok' ? probe.state : null;
    const segments = (st && Array.isArray(st.segments)) ? st.segments : [];
    const dropped = (st && Array.isArray(st.dropped)) ? st.dropped : [];
    const key = (st ? 'ok' : 'none') + ':' + listKey(segments, dropped);
    const segSec = $('segSec'), dropSec = $('droppedSec'), manualSec = $('manualSec');
    manualSec.hidden = !st || st.status === 'ignored' || st.status === 'disabled';
    if (key === lastKey) return;
    lastKey = key;

    const list = $('segList');
    list.textContent = '';
    for (const seg of segments) list.appendChild(segRow(seg, false));
    segSec.hidden = segments.length === 0;

    const dl = $('droppedList');
    dl.textContent = '';
    for (const c of dropped) dl.appendChild(segRow(c, true));
    $('droppedLabel').textContent = `低置信度 (${dropped.length})`;
    dropSec.hidden = dropped.length === 0;
  }

  function renderMarks() {
    const hint = $('manualHint');
    const cid = lastProbe && lastProbe.state && lastProbe.state.video ? lastProbe.state.video.cid : null;
    const m = marks && (marks.cid == null || cid == null || String(marks.cid) === String(cid)) ? marks : null;
    $('markClear').hidden = !m;
    $('markStart').classList.toggle('primary', !!(m && m.start == null));
    $('markEnd').classList.toggle('primary', !!(m && m.start != null && m.end == null));
    hint.textContent = '';
    if (!m) {
      hint.textContent = '播放到广告开始处点「标记广告开始」，播放到结束处点「标记广告结束」。';
      return;
    }
    hint.appendChild(document.createTextNode('开始 '));
    hint.appendChild(el('b', '', m.start != null ? fmtTime(m.start) : '未设'));
    hint.appendChild(document.createTextNode(' · 结束 '));
    hint.appendChild(el('b', '', m.end != null ? fmtTime(m.end) : '未设'));
  }

  function setControlsEnabled(on) {
    for (const id of ['rescan', 'clearOverrides', 'markStart', 'markEnd', 'skipHere']) $(id).disabled = !on;
  }

  // ---------- data flow ----------
  async function probe() {
    const tab = await getActiveTab();
    if (!tab || tab.id == null || !isVideoUrl(tab.url)) { tabId = null; return { kind: 'notVideo', tabTitle: tab && tab.title }; }
    tabId = tab.id;
    const resp = await sendToTab(tab.id, { type: 'BAS_GET_STATE' });
    if (!resp || resp.noReceiver || !resp.ok && !resp.status) return { kind: 'noReceiver', tabTitle: tab.title };
    return { kind: 'ok', state: resp, tabTitle: tab.title };
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      lastProbe = await probe();
      renderStatus(lastProbe);
      renderLists(lastProbe);
      renderMarks();
      setControlsEnabled(lastProbe.kind === 'ok');
    } catch (e) {
      // Never let a render error kill the refresh loop.
    } finally { busy = false; }
  }

  /** Send an action message to the tab, then refresh. */
  async function act(msg, okToast) {
    if (tabId == null) { showToast('请在 B 站视频页使用'); return null; }
    const resp = await sendToTab(tabId, msg);
    if (!resp || resp.noReceiver) { showToast('页面脚本未就绪，请刷新'); return null; }
    if (resp.ok === false) { showToast(resp.error ? '失败：' + String(resp.error).slice(0, 40) : '操作失败'); return resp; }
    if (okToast) showToast(okToast);
    lastKey = null;
    await refresh();
    return resp;
  }

  async function currentTime() {
    if (tabId == null) return null;
    const resp = await sendToTab(tabId, { type: 'BAS_GET_STATE' });
    if (!resp || resp.noReceiver) { showToast('页面脚本未就绪，请刷新'); return null; }
    const t = Number(resp.currentTime);
    if (!isFinite(t)) { showToast('无法读取当前播放时间'); return null; }
    return { t, cid: resp.video ? resp.video.cid : null };
  }

  async function markStart() {
    const cur = await currentTime();
    if (!cur) return;
    marks = Object.assign({}, marks && String(marks.cid) === String(cur.cid) ? marks : { cid: cur.cid, end: null }, { cid: cur.cid, start: cur.t });
    await maybeSubmitMarks();
  }
  async function markEnd() {
    const cur = await currentTime();
    if (!cur) return;
    marks = Object.assign({}, marks && String(marks.cid) === String(cur.cid) ? marks : { cid: cur.cid, start: null }, { cid: cur.cid, end: cur.t });
    await maybeSubmitMarks();
  }
  async function maybeSubmitMarks() {
    if (marks && marks.start != null && marks.end != null) {
      let a = Math.min(marks.start, marks.end), b = Math.max(marks.start, marks.end);
      if (b - a < 5) {
        showToast('区间太短（至少 5 秒），请重新标记结束');
        marks.end = null;
      } else {
        marks = null;
        await saveMarks(null);
        renderMarks();
        await act({ type: 'BAS_ADD_SEGMENT', start: Math.round(a * 10) / 10, end: Math.round(b * 10) / 10 }, '已添加手动广告段');
        return;
      }
    }
    await saveMarks(marks);
    renderMarks();
    if (marks && marks.start != null && marks.end == null) showToast('已记录开始 ' + fmtTime(marks.start) + '，播放到结束处再标记');
    else if (marks && marks.end != null && marks.start == null) showToast('已记录结束 ' + fmtTime(marks.end) + '，请标记开始');
  }

  // ---------- wiring ----------
  async function init() {
    settings = await loadSettings();
    renderSettings();
    marks = await loadMarks();

    $('enabled').addEventListener('change', (ev) => {
      settings.enabled = !!ev.target.checked;
      saveSettings({ enabled: settings.enabled });
    });
    $('modeCtrl').addEventListener('click', (ev) => {
      const b = ev.target.closest('.seg-btn');
      if (!b || !b.dataset.mode) return;
      settings.mode = b.dataset.mode === 'manual' ? 'manual' : 'auto';
      renderSettings();
      lastKey = null;
      saveSettings({ mode: settings.mode }).then(refresh);
    });
    $('droppedToggle').addEventListener('click', () => {
      const t = $('droppedToggle');
      const open = t.getAttribute('aria-expanded') !== 'true';
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
      $('droppedList').hidden = !open;
    });
    $('markStart').addEventListener('click', markStart);
    $('markEnd').addEventListener('click', markEnd);
    $('markClear').addEventListener('click', async () => { marks = null; await saveMarks(null); renderMarks(); });
    $('rescan').addEventListener('click', () => act({ type: 'BAS_RESCAN' }, '已开始重新检测'));
    $('skipHere').addEventListener('click', () => act({ type: 'BAS_SKIP_HERE' }, '已跳过当前广告'));
    $('clearOverrides').addEventListener('click', () => act({ type: 'BAS_CLEAR_OVERRIDES' }, '已清除本视频覆盖'));
    $('openOptions').addEventListener('click', () => {
      try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.settings) {
          settings = mergeSettings(changes.settings.newValue);
          renderSettings();
          lastKey = null;
        }
      });
    } catch (e) { /* ignore */ }

    await refresh();
    timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearInterval(timer); timer = null; }
      else if (!timer) { refresh(); timer = setInterval(refresh, REFRESH_MS); }
    });
    window.addEventListener('unload', () => { clearInterval(timer); clearTimeout(toastTimer); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
