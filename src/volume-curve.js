/* Bilibili Ad Skipper — a volume slider that sounds even (MAIN world, www.bilibili.com and live.bilibili.com).
 *
 * The bilibili video and live players set a media element's `volume` straight from their slider (0–1), but `volume` is
 * an amplitude and hearing is logarithmic: 50 % on the slider is only 6 dB below full, 10 % still 20 dB — most of the
 * slider sounds loud and the quiet end barely exists. Here the slider value goes through a power curve
 * (amplitude = slider ^ exponent; 2.5 by default: 50 % ≈ −15 dB, 10 % ≈ −50 dB) before it reaches the element, and
 * reading `volume` back gives the slider value again, so the player's own UI, saved volume and mute logic are unchanged.
 * Covers <video> / <audio> and the player's own <bwp-video> element (its WebAssembly decoder), whatever creates them.
 * The exponent comes from the extension's settings (volume-settings.js, isolated world); 1 turns it off.
 */
(() => {
  const ONCE = Symbol.for('bas.volumeCurve');
  if (window[ONCE]) return;
  Object.defineProperty(window, ONCE, { value: true });

  const DEFAULT_EXPONENT = 2.5;
  let k = DEFAULT_EXPONENT;                 // until the setting arrives (a few ms after load)
  const slider = new WeakMap();             // element → {s: the value the page set, a: the level written for it}
  const tracked = new Set();                // WeakRefs of every element set, also outside the document (PiP window)
  const curve = (s) => (k > 1 ? Math.pow(s, k) : s);
  const inverse = (a) => (k > 1 ? Math.pow(a, 1 / k) : a);
  const realSet = new WeakMap();            // prototype → the original accessor (to re-apply levels)

  /** Wrap the `volume` accessor that `proto` sees (its own or inherited) with the curve, on `proto` itself. */
  function wrap(proto) {
    if (!proto || Object.prototype.hasOwnProperty.call(proto, '__basVolumeWrapped')) return;
    let d = null, owner = null;
    for (let p = proto; p && !d; p = Object.getPrototypeOf(p)) { d = Object.getOwnPropertyDescriptor(p, 'volume'); owner = p; }
    if (!d || typeof d.get !== 'function' || typeof d.set !== 'function') return;
    if (Object.prototype.hasOwnProperty.call(owner, '__basVolumeWrapped')) return;   // inherits an accessor already curved
    Object.defineProperty(proto, '__basVolumeWrapped', { value: true });
    realSet.set(proto, d);
    Object.defineProperty(proto, 'volume', {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const real = d.get.call(this);
        const st = slider.get(this);
        if (st !== undefined && Math.abs(st.a - real) < 1e-7) return st.s;
        return typeof real === 'number' && real >= 0 && real <= 1 ? inverse(real) : real;   // set some other way
      },
      set(v) {
        const s = Number(v);
        if (!(s >= 0 && s <= 1)) { d.set.call(this, v); return; }   // out of range: the browser throws as usual
        if (!slider.has(this) && typeof WeakRef === 'function') tracked.add(new WeakRef(this));
        d.set.call(this, curve(s));
        slider.set(this, { s, a: d.get.call(this) });
      },
    });
  }
  if (window.HTMLMediaElement) wrap(HTMLMediaElement.prototype);
  // the player's own media element is a custom element defined later by its scripts
  const CE = window.customElements;
  if (CE && typeof CE.define === 'function') {
    const define = CE.define;
    CE.define = function (name, ctor, opts) {
      if (name === 'bwp-video' && ctor && ctor.prototype) { try { wrap(ctor.prototype); } catch (e) { /* leave it */ } }
      return define.call(this, name, ctor, opts);
    };
    try { const B = CE.get('bwp-video'); if (B) wrap(B.prototype); } catch (e) { /* none */ }
  }

  /** New exponent: every media element set so far (and every one in this document) keeps its slider value. */
  function setExponent(e) {
    if (!(typeof e === 'number' && isFinite(e) && e >= 1 && e <= 5)) return;   // not a value the settings can hold
    if (e === k) return;
    const els = new Set(document.querySelectorAll('video, audio, bwp-video'));
    for (const r of Array.from(tracked)) { const el = r.deref(); if (el) els.add(el); else tracked.delete(r); }
    const keep = Array.from(els, (el) => [el, el.volume]);
    k = e;
    for (const [el, s] of keep) {
      if (typeof s !== 'number' || !(s >= 0 && s <= 1)) continue;
      let acc = null;
      for (let p = Object.getPrototypeOf(el); p && !acc; p = Object.getPrototypeOf(p)) acc = realSet.get(p) || null;
      if (!acc) continue;
      try { acc.set.call(el, curve(s)); slider.set(el, { s, a: acc.get.call(el) }); } catch (err) { /* not ready */ }
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== 'BAS_VOLUME_CURVE') return;
    setExponent(+ev.data.exponent);
  });
  // ask for the setting in case it was sent before this listener existed
  try { window.postMessage({ type: 'BAS_VOLUME_HELLO' }, location.origin); } catch (e) { /* opaque origin */ }
})();
