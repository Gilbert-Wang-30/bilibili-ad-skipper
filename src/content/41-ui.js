/* Bilibili Ad Skipper — in-player UI: progress markers, toasts, skip button, badge.
 * Classic script. Defines BAS.ui only; touches the DOM exclusively inside functions
 * (so the file can be evaluated in Deno where `document` is undefined). */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) return;
  if (BAS.ui && BAS.ui.__loaded) return;

  /** @typedef {import('./00-ns.js')} _ns */
  /** @typedef {{start:number,end:number|null,source:string,confidence:number,reason:string,offerOnly?:boolean,id?:string,sources?:string[],autoSkip?:boolean,enabled?:boolean}} Segment */

  const SEL = {
    container: '.bpx-player-container',
    videoArea: '.bpx-player-video-area',
    progress: '.bpx-player-progress',
    shadow: '.bpx-player-shadow-progress-area',
    exclude: '.v-recommend-inline-player', // inline preview players also instantiate bpx
  };
  const COLORS = Object.freeze({ chapter: '#ff7a45', danmaku: '#fb7299', user: '#52c41a', media: '#40a9ff', heat: '#faad14' });
  const MAX_TOASTS = 2;
  const FADE_MS = 260;
  const DEFAULT_TOAST_MS = 6000;

  // ---------- state ----------
  const st = {
    container: null,     // .bpx-player-container we are mounted in
    layer: null,         // div.bas-layer (reused across re-mounts; children survive)
    toastHost: null,     // div.bas-toasts
    skip: null,          // button.bas-skip
    skipLabel: null,
    skipSub: null,
    skipHandler: null,   // current onClick for the skip button
    skipOpts: null,      // last showSkipButton opts (re-applied on refresh)
    badge: null,         // div.bas-badge
    badgeNum: null,
    badgeCount: 0,
    toasts: [],          // [{el, timer, remaining, startedAt, raf, closed}]
    timers: new Set(),   // every pending setTimeout id (cleared in destroy)
    segments: [],        // last rendered segments
    duration: 0,
  };

  // ---------- helpers ----------
  const hasDOM = () => typeof document !== 'undefined' && !!document.createElement;
  const fmt = (s) => BAS.util.fmtTime(s);
  const settings = () => (BAS.state && BAS.state.settings) || BAS.DEFAULT_SETTINGS;

  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v);
      }
    }
    return n;
  }
  function later(fn, ms) {
    const id = setTimeout(() => { st.timers.delete(id); try { fn(); } catch (e) { BAS.warn('ui timer', e); } }, ms);
    st.timers.add(id);
    return id;
  }
  function cancel(id) { if (id != null) { clearTimeout(id); st.timers.delete(id); } }
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => { try { fn(); } catch (e) { BAS.warn('ui raf', e); } });
    return later(fn, 16);
  }
  function remove(node) { try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (_) { /* ignore */ } }
  const swallow = (e) => { e.stopPropagation(); };
  const isActivationKey = (e) => e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar';
  const swallowActivationKey = (e) => { if (isActivationKey(e)) e.stopPropagation(); };

  /** Keep the player from reacting (play/pause toggle, hotkeys, context menu) to clicks on our buttons. */
  function guardButton(btn) {
    for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu']) {
      btn.addEventListener(t, swallow);
    }
    btn.addEventListener('keydown', swallowActivationKey);
    btn.addEventListener('keyup', swallowActivationKey);
    btn.addEventListener('keypress', swallowActivationKey);
  }

  /** Minimal allow-list sanitiser for toast `html` (reasons may embed uploader-provided chapter names). */
  function sanitizeHTML(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html);
    const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'SPAN', 'BR', 'SMALL', 'CODE', 'U', 'S']);
    const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH']);
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        const tag = child.tagName.toUpperCase();
        if (DROP.has(tag)) { child.remove(); continue; }
        if (!KEEP.has(tag)) { walk(child); child.replaceWith(...Array.from(child.childNodes)); continue; }
        for (const a of Array.from(child.attributes)) {
          if (a.name !== 'class' || !/^(bas-[\w-]+\s*)+$/.test(a.value)) child.removeAttribute(a.name);
        }
        walk(child);
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  function notInlinePlayer(node) {
    try { return !node.closest(SEL.exclude); } catch (_) { return true; }
  }
  function findAll(root, sel) {
    try { return Array.from(root.querySelectorAll(sel)).filter(notInlinePlayer); } catch (_) { return []; }
  }

  /** Accepts the container itself, any ancestor/descendant of it, or nothing (document lookup). */
  function resolveContainer(c) {
    try {
      if (c && c.nodeType === 1) {
        if (c.matches(SEL.container)) return c;
        const down = findAll(c, SEL.container)[0];
        if (down) return down;
        const up = c.closest(SEL.container);
        if (up) return up;
      }
      if (st.container && st.container.isConnected) return st.container;
      return document.querySelector('#bilibili-player ' + SEL.container) || findAll(document, SEL.container)[0] || null;
    } catch (e) {
      BAS.warn('ui.resolveContainer', e);
      return null;
    }
  }

  // ---------- layer (toasts / skip / badge) ----------
  function buildLayer() {
    const layer = el('div', 'bas-layer', { 'data-bas-version': BAS.VERSION });

    const badge = el('div', 'bas-badge', { 'aria-hidden': 'true' });
    badge.appendChild(el('span', 'bas-badge__dot'));
    const badgeNum = el('span', 'bas-badge__num', { text: '0' });
    badge.appendChild(badgeNum);
    layer.appendChild(badge);

    const toastHost = el('div', 'bas-toasts', { 'aria-live': 'polite' });
    layer.appendChild(toastHost);

    const skip = el('button', 'bas-skip', { type: 'button', 'aria-label': '跳过广告', title: '跳过广告' });
    skip.appendChild(el('span', 'bas-skip__icon', { 'aria-hidden': 'true', text: '▶' }));
    const text = el('span', 'bas-skip__text');
    const label = el('span', 'bas-skip__label', { text: '跳过广告' });
    const sub = el('span', 'bas-skip__sub');
    text.appendChild(label);
    text.appendChild(sub);
    skip.appendChild(text);
    guardButton(skip);
    skip.addEventListener('click', (e) => {
      const h = st.skipHandler;
      if (!h) return;
      try { h(e); } catch (err) { BAS.warn('skip button handler', err); }
    });
    layer.appendChild(skip);

    st.layer = layer;
    st.toastHost = toastHost;
    st.skip = skip;
    st.skipLabel = label;
    st.skipSub = sub;
    st.badge = badge;
    st.badgeNum = badgeNum;
    applyBadge();
  }

  function ensureLayer(container) {
    const area = container.querySelector(SEL.videoArea) || container;
    if (!st.layer) buildLayer();
    // appendChild moves an existing node (children + listeners preserved) and keeps us last → on top.
    if (st.layer.parentNode !== area) area.appendChild(st.layer);
  }

  // ---------- markers ----------
  function markerHosts() {
    if (!st.container) return [];
    return findAll(st.container, SEL.progress).map((h) => ({ host: h, shadow: false }))
      .concat(findAll(st.container, SEL.shadow).map((h) => ({ host: h, shadow: true })));
  }

  function ensureMarkerHosts() {
    for (const { host, shadow } of markerHosts()) {
      let m = null;
      for (const c of host.children) { if (c.classList && c.classList.contains('bas-markers')) { m = c; break; } }
      if (!m) {
        m = el('div', 'bas-markers ' + (shadow ? 'bas-markers--shadow' : 'bas-markers--main'), { 'aria-hidden': 'true' });
        // In the main bar, sit right before the drag thumb so (with z-index auto) markers paint above the played/
        // buffered fill but below bilibili's thumb and hover popups.
        let before = null;
        if (!shadow) for (const c of host.children) { if (c.classList && c.classList.contains('bpx-player-progress-thumb')) { before = c; break; } }
        if (before) host.insertBefore(m, before); else host.appendChild(m);
        paint(m);
      }
    }
  }

  function markerTitle(seg, start, end) {
    let t = '广告 ' + fmt(start) + ' - ' + fmt(end) + ' · ' + (seg.reason || '');
    if (seg.enabled === false) t += '（已忽略）';
    else if (seg.offerOnly) t += '（仅提示，不自动跳过）';
    else if (seg.autoSkip === false) t += '（置信度低，不自动跳过）';
    return t;
  }

  /** Build marker nodes for the current segments into one .bas-markers container. */
  function paintSignature() {
    const dur = st.duration;
    if (!(dur > 0) || settings().showMarkers === false) return 'none';
    return dur.toFixed(2) + '|' + st.segments.map((s) => s ? [s.id, s.start, s.end, s.enabled, s.autoSkip, s.offerOnly, s.source, s.reason].join(',') : '').join(';');
  }

  /** Build marker nodes for the current segments into one .bas-markers container (no-op when nothing changed). */
  function paint(m) {
    const sig = paintSignature();
    if (m.__basSig === sig) return;          // idempotent: repeated renders must not churn the player's DOM
    m.__basSig = sig;
    const frag = document.createDocumentFragment();
    const dur = st.duration;
    if (dur > 0 && settings().showMarkers !== false) {
      for (const seg of st.segments) {
        if (!seg) continue;
        const s0 = Number(seg.start), e0 = Number(seg.end);
        if (!isFinite(s0) || !isFinite(e0)) continue;
        const start = BAS.util.clamp(s0, 0, dur);
        const end = BAS.util.clamp(e0, 0, dur);
        if (end <= start) continue;
        const node = el('div', 'bas-marker', {
          'data-id': seg.id || (seg.source + ':' + Math.round(start) + '-' + Math.round(end)),
          'data-source': seg.source || 'danmaku',
          title: markerTitle(seg, start, end),
        });
        if (seg.enabled === false) node.classList.add('bas-marker--off');
        if (seg.offerOnly) node.classList.add('bas-marker--offer');
        if (seg.autoSkip === false || seg.offerOnly) node.classList.add('bas-marker--low');
        const color = COLORS[seg.source];
        if (color) node.style.setProperty('--bas-marker-color', color);
        node.style.left = (start / dur * 100).toFixed(3) + '%';
        node.style.width = ((end - start) / dur * 100).toFixed(3) + '%';
        frag.appendChild(node);
      }
    }
    while (m.firstChild) m.removeChild(m.firstChild);
    m.appendChild(frag);
  }

  function repaintAll() {
    if (!st.container) return;
    for (const m of findAll(st.container, '.bas-markers')) paint(m);
  }

  // ---------- toasts ----------
  function toastPause(rec) {
    if (rec.closed || rec.timer == null) return;
    cancel(rec.timer); rec.timer = null;
    rec.remaining = Math.max(500, rec.remaining - (Date.now() - rec.startedAt));
  }
  function toastResume(rec) {
    if (rec.closed || !isFinite(rec.remaining) || rec.remaining <= 0) return;
    cancel(rec.timer);
    rec.startedAt = Date.now();
    rec.timer = later(() => closeToast(rec), rec.remaining);
  }
  function closeToast(rec, immediate) {
    if (!rec || rec.closed) return;
    rec.closed = true;
    cancel(rec.timer); rec.timer = null;
    if (rec.raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rec.raf);
    const i = st.toasts.indexOf(rec);
    if (i >= 0) st.toasts.splice(i, 1);
    rec.el.classList.remove('bas-toast--show');
    if (immediate) remove(rec.el);
    else later(() => remove(rec.el), FADE_MS);
  }

  // ---------- badge ----------
  function applyBadge() {
    if (!st.badge) return;
    const n = st.badgeCount | 0;
    st.badgeNum.textContent = String(n);
    st.badge.title = n > 0 ? '已识别 ' + n + ' 段广告' : '';
    st.badge.classList.toggle('bas-badge--show', n > 0);
  }

  // ---------- public API ----------

  /**
   * Mount into the player. Idempotent: safe to call on every MutationObserver tick.
   * @param {Element} [container] .bpx-player-container (or any node inside/above it; omit → document lookup)
   * @returns {boolean} mounted
   */
  function mount(container) {
    if (!hasDOM()) return false;
    try {
      const c = resolveContainer(container);
      if (!c) return false;
      if (st.container !== c) {
        BAS.debug('ui: mounting into new container');
        st.container = c;
      }
      ensureLayer(c);
      ensureMarkerHosts();
      return true;
    } catch (e) {
      BAS.warn('ui.mount failed', e);
      return false;
    }
  }

  /** Re-append anything bilibili's re-render dropped (layer, marker containers). Call from a MutationObserver. */
  function refresh() {
    if (!hasDOM()) return false;
    try {
      const c = resolveContainer(st.container && st.container.isConnected ? st.container : null);
      if (!c) return false;
      const ok = mount(c);
      if (ok && st.skipOpts && st.skipHandler && !st.skip.classList.contains('bas-skip--show')) {
        showSkipButton(st.skipOpts);
      }
      return ok;
    } catch (e) {
      BAS.warn('ui.refresh failed', e);
      return false;
    }
  }

  /**
   * Draw segment markers in the main progress bar and the thin shadow bar.
   * @param {Segment[]} segments
   * @param {number} duration seconds
   */
  function renderMarkers(segments, duration) {
    st.segments = Array.isArray(segments) ? segments.slice() : [];
    st.duration = isFinite(duration) && duration > 0 ? Number(duration) : 0;
    if (!hasDOM()) return;
    try {
      if (st.container && st.container.isConnected) ensureMarkerHosts();
      else mount();
      repaintAll();
    } catch (e) {
      BAS.warn('ui.renderMarkers failed', e);
    }
  }

  function clearMarkers() { renderMarkers([], st.duration); }

  /**
   * Show a toast card (top-right). Stack ≤ 2; auto-hides; hide pauses while hovered.
   * @param {{text?:string, html?:string, actionLabel?:string, onAction?:Function, durationMs?:number}|string} opts
   * @returns {{close:Function, el:Element|null}}
   */
  function showToast(opts) {
    const handle = { close() {}, el: null };
    if (!hasDOM()) return handle;
    try {
      if (typeof opts === 'string') opts = { text: opts };
      opts = opts || {};
      if (!mount()) return handle;
      if (settings().showToast === false && !opts.force) return handle;

      const toast = el('div', 'bas-toast', { role: 'status' });
      const text = el('div', 'bas-toast__text');
      if (opts.html) text.innerHTML = sanitizeHTML(opts.html);
      else text.textContent = opts.text != null ? String(opts.text) : '';
      toast.appendChild(text);

      const rec = { el: toast, timer: null, remaining: 0, startedAt: 0, raf: null, closed: false };

      if (opts.actionLabel) {
        const btn = el('button', 'bas-toast__btn', { type: 'button', text: String(opts.actionLabel) });
        guardButton(btn);
        btn.addEventListener('click', () => {
          try { if (typeof opts.onAction === 'function') opts.onAction(); } catch (e) { BAS.warn('toast action', e); }
          closeToast(rec);
        });
        toast.appendChild(btn);
      }
      const close = el('button', 'bas-toast__close', { type: 'button', 'aria-label': '关闭', title: '关闭', text: '×' });
      guardButton(close);
      close.addEventListener('click', () => closeToast(rec));
      toast.appendChild(close);

      let ms = opts.durationMs;
      if (ms == null) ms = settings().toastDurationMs;
      ms = Number(ms);
      rec.remaining = isFinite(ms) && ms > 0 ? ms : (ms === 0 || ms === Infinity ? Infinity : DEFAULT_TOAST_MS);

      toast.addEventListener('mouseenter', () => toastPause(rec));
      toast.addEventListener('mouseleave', () => toastResume(rec));
      toast.addEventListener('focusin', () => toastPause(rec));
      toast.addEventListener('focusout', () => toastResume(rec));

      while (st.toasts.length >= MAX_TOASTS) closeToast(st.toasts[0]);
      st.toasts.push(rec);
      st.toastHost.appendChild(toast);
      rec.raf = nextFrame(() => { rec.raf = null; if (!rec.closed) toast.classList.add('bas-toast--show'); });
      toastResume(rec);

      handle.close = () => closeToast(rec);
      handle.el = toast;
      return handle;
    } catch (e) {
      BAS.warn('ui.showToast failed', e);
      return handle;
    }
  }

  function dismissToasts() {
    for (const rec of st.toasts.slice()) closeToast(rec, true);
  }

  /**
   * Show the YouTube-style skip pill (bottom-right above the control bar). Does not steal focus.
   * @param {{label?:string, sub?:string, title?:string, onClick?:Function}} opts
   */
  function showSkipButton(opts) {
    if (!hasDOM()) return;
    try {
      opts = opts || {};
      if (!mount()) return;
      st.skipOpts = opts;
      st.skipHandler = typeof opts.onClick === 'function' ? opts.onClick : null;
      const label = String(opts.label || '跳过广告').replace(/\s*▶\s*$/, '') || '跳过广告';
      const sub = opts.sub != null ? String(opts.sub) : '';
      st.skipLabel.textContent = label;
      st.skipSub.textContent = sub;
      const title = opts.title || (sub ? label + ' ' + sub : label);
      st.skip.title = title;
      st.skip.setAttribute('aria-label', title);
      st.skip.classList.add('bas-skip--show');
    } catch (e) {
      BAS.warn('ui.showSkipButton failed', e);
    }
  }

  function hideSkipButton() {
    st.skipHandler = null;
    st.skipOpts = null;
    if (st.skip) st.skip.classList.remove('bas-skip--show');
  }

  /** Tiny count bubble (top-left). 0 hides it. */
  function setBadge(count) {
    st.badgeCount = Math.max(0, Number(count) | 0);
    try { applyBadge(); } catch (e) { BAS.warn('ui.setBadge failed', e); }
  }

  function isMounted() {
    return !!(st.layer && st.layer.isConnected && st.container && st.container.isConnected);
  }

  /** Remove every node, listener and timer we created. */
  function destroy() {
    try {
      for (const rec of st.toasts.slice()) { rec.closed = true; if (rec.raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rec.raf); }
      st.toasts = [];
      for (const id of st.timers) clearTimeout(id);
      st.timers.clear();
      if (hasDOM()) {
        remove(st.layer);
        const roots = [];
        if (st.container) roots.push(st.container);
        roots.push(document);
        for (const r of roots) for (const n of findAll(r, '.bas-markers, .bas-layer')) remove(n);
      }
    } catch (e) {
      BAS.warn('ui.destroy', e);
    }
    st.container = null;
    st.layer = null; st.toastHost = null;
    st.skip = null; st.skipLabel = null; st.skipSub = null; st.skipHandler = null; st.skipOpts = null;
    st.badge = null; st.badgeNum = null; st.badgeCount = 0;
    st.segments = []; st.duration = 0;
  }

  BAS.ui = {
    __loaded: true,
    COLORS,
    mount,
    refresh,
    renderMarkers,
    clearMarkers,
    showToast,
    dismissToasts,
    showSkipButton,
    hideSkipButton,
    setBadge,
    isMounted,
    destroy,
  };
})();
