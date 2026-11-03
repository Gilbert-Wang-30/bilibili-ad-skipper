/* Bilibili Ad Skipper — hands the volume-curve setting to volume-curve.js (which runs in the page and cannot read the
 * extension's storage). Isolated world, www.bilibili.com and live.bilibili.com. Sends nothing anywhere else. */
(() => {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;
  const DEFAULT_EXPONENT = 2.5;
  const CURVES = [1, 1.8, 2.5, 3.5];          // the options page's choices (options.js VOLUME_CURVES)
  let exponent = null;
  const send = () => {
    if (exponent == null) return;
    try { window.postMessage({ type: 'BAS_VOLUME_CURVE', exponent }, location.origin); } catch (e) { /* opaque origin */ }
  };
  const read = (s) => {
    const v = s && typeof s === 'object' ? Number(s.volumeCurve) : NaN;
    exponent = CURVES.includes(v) ? v : DEFAULT_EXPONENT;
  };
  try {
    chrome.storage.sync.get('settings', (r) => { read(r && r.settings); send(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) { read(changes.settings.newValue); send(); }
    });
  } catch (e) { return; }
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.type === 'BAS_VOLUME_HELLO') send();
  });
})();
