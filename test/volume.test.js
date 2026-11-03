// Tests for src/volume-curve.js (MAIN world: the slider value → amplitude curve) and src/volume-settings.js (isolated
// world: hands the setting over), against a fake media element with a native-like `volume` accessor.
import { assert, assertEquals } from './assert.js';

const CURVE_SRC = Deno.readTextFileSync(new URL('../src/volume-curve.js', import.meta.url));
const SETTINGS_SRC = Deno.readTextFileSync(new URL('../src/volume-settings.js', import.meta.url));
const near = (a, b) => Math.abs(a - b) < 1e-9;

/** A page: a media element class like HTMLMediaElement (range-checked amplitude), a custom element registry, messaging. */
function makePage() {
  class Media {
    constructor() { this._v = 1; }
  }
  Object.defineProperty(Media.prototype, 'volume', {
    configurable: true, enumerable: true,
    get() { return this._v; },
    set(v) { const x = Number(v); if (!(x >= 0 && x <= 1)) throw new RangeError('IndexSizeError'); this._v = x; },
  });
  const listeners = [], els = [], defined = new Map();
  const win = {
    HTMLMediaElement: Media,
    customElements: { define(name, ctor) { defined.set(name, ctor); }, get: (name) => defined.get(name) },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { for (const fn of listeners.slice()) fn({ source: win, data }); },
  };
  const doc = { querySelectorAll: () => els };
  const real = (el) => el._v;
  return { win, doc, Media, els, real, defined, run: (src, extra = {}) => new Function('window', 'document', 'location', 'HTMLMediaElement', 'chrome', src)(win, doc, { origin: 'https://www.bilibili.com' }, Media, extra.chrome) };
}

Deno.test('volume curve: the page reads back the slider value, the element plays it at slider ^ 2.5', () => {
  const pg = makePage();
  pg.run(CURVE_SRC);
  const v = new pg.Media(); pg.els.push(v);
  for (const s of [1, 0.9, 0.5, 0.1, 0.01, 0]) {
    v.volume = s;
    assertEquals(v.volume, s);
    assert(near(pg.real(v), Math.pow(s, 2.5)), `${s}: ${pg.real(v)}`);
  }
  v.volume = 0.5;
  assert(Math.abs(20 * Math.log10(pg.real(v)) + 15.05) < 0.05, 'half the slider is about −15 dB');
  // out of range still throws like the browser does
  let threw = false; try { v.volume = 1.5; } catch (e) { threw = e instanceof RangeError; }
  assert(threw);
  // a level set some other way (bypassing the curve) reads back as the slider value that gives it
  v._v = Math.pow(0.4, 2.5);
  assert(near(v.volume, 0.4), String(v.volume));
});

Deno.test('volume curve: the setting changes the curve live and keeps every slider where it was; 1 turns it off', () => {
  const pg = makePage();
  pg.run(CURVE_SRC);
  const a = new pg.Media(), b = new pg.Media(); pg.els.push(a, b);
  a.volume = 0.5; b.volume = 0.2;
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 1 });
  assertEquals([a.volume, b.volume], [0.5, 0.2]);
  assert(near(pg.real(a), 0.5) && near(pg.real(b), 0.2));
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 3.5 });
  assertEquals([a.volume, b.volume], [0.5, 0.2]);
  assert(near(pg.real(a), Math.pow(0.5, 3.5)));
  // values the settings cannot hold are ignored
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 99 });
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 'loud' });
  assert(near(pg.real(a), Math.pow(0.5, 3.5)));
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 1 });
  assert(near(pg.real(a), 0.5));
  // other messages and other senders are ignored
  pg.win.postMessage({ type: 'SOMETHING', exponent: 2.5 });
  assert(near(pg.real(a), 0.5));
});

Deno.test('volume curve: the player\'s own <bwp-video>, defined later, is curved once; loading twice is harmless', () => {
  const pg = makePage();
  pg.run(CURVE_SRC);
  pg.run(CURVE_SRC);   // a second injection (frames, reloads of the script) changes nothing
  class Bwp { constructor() { this._g = 1; } }
  Object.defineProperty(Bwp.prototype, 'volume', { configurable: true, get() { return this._g; }, set(v) { this._g = +v; } });
  pg.win.customElements.define('bwp-video', Bwp);
  const w = new Bwp(); pg.els.push(w);
  w.volume = 0.5;
  assertEquals(w.volume, 0.5);
  assert(near(w._g, Math.pow(0.5, 2.5)), String(w._g));
  // a custom element that inherits the (already curved) media accessor is not curved twice
  class Sub extends pg.Media {}
  pg.win.customElements.define('bwp-video', Sub);
  const s = new Sub();
  s.volume = 0.5;
  assert(near(pg.real(s), Math.pow(0.5, 2.5)), String(pg.real(s)));
  const v = new pg.Media();
  v.volume = 0.5;
  assert(near(pg.real(v), Math.pow(0.5, 2.5)), 'not curved twice after a second injection');
});

Deno.test('volume settings: the stored exponent (or the default 2.5) reaches the page, also on request and on change', () => {
  const pg = makePage();
  const sent = [];
  pg.win.addEventListener('message', (ev) => { if (ev.data.type === 'BAS_VOLUME_CURVE') sent.push(ev.data.exponent); });
  let onChanged = null;
  let stored = { settings: { volumeCurve: 1.8 } };
  const chrome = { storage: { sync: { get: (k, cb) => cb(stored) }, onChanged: { addListener: (fn) => { onChanged = fn; } } } };
  pg.run(SETTINGS_SRC, { chrome });
  assertEquals(sent, [1.8]);
  pg.win.postMessage({ type: 'BAS_VOLUME_HELLO' });
  assertEquals(sent, [1.8, 1.8]);
  onChanged({ settings: { newValue: { volumeCurve: 1 } } }, 'sync');
  onChanged({ settings: { newValue: { volumeCurve: 'x' } } }, 'sync');
  onChanged({ other: {} }, 'sync');
  assertEquals(sent, [1.8, 1.8, 1, 2.5]);
  // no settings stored yet: the default
  const pg2 = makePage(), sent2 = [];
  pg2.win.addEventListener('message', (ev) => { if (ev.data.type === 'BAS_VOLUME_CURVE') sent2.push(ev.data.exponent); });
  stored = {};
  pg2.run(SETTINGS_SRC, { chrome });
  assertEquals(sent2, [2.5]);
});

Deno.test('volume curve: an element outside the document (picture-in-picture window) follows a setting change too', () => {
  const pg = makePage();
  pg.run(CURVE_SRC);
  const v = new pg.Media();          // never in document.querySelectorAll
  v.volume = 0.5;
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 1 });
  assertEquals(v.volume, 0.5);
  assert(near(pg.real(v), 0.5), String(pg.real(v)));
  pg.win.postMessage({ type: 'BAS_VOLUME_CURVE', exponent: 3.5 });
  assertEquals(v.volume, 0.5);
  assert(near(pg.real(v), Math.pow(0.5, 3.5)), String(pg.real(v)));
  // a copy made by the player when it swaps elements (n.volume = old.volume) keeps the slider value
  const n = new pg.Media();
  n.volume = v.volume;
  assertEquals(n.volume, 0.5);
});

Deno.test('volume settings: one list of curves and one default everywhere (options page, settings, both page scripts, manifest)', () => {
  const html = Deno.readTextFileSync(new URL('../src/options/options.html', import.meta.url));
  const sel = /<select name="volumeCurve">([\s\S]*?)<\/select>/.exec(html);
  assert(sel, 'options.html has the volumeCurve select');
  const opts = [...sel[1].matchAll(/value="([\d.]+)"/g)].map((m) => +m[1]);
  const optionsJs = Deno.readTextFileSync(new URL('../src/options/options.js', import.meta.url));
  const list = (src, name) => JSON.parse(new RegExp(String.raw`const ${name} = (\[[^\]]*\])`).exec(src)[1]);
  assertEquals(list(optionsJs, 'VOLUME_CURVES'), opts);
  assertEquals(list(SETTINGS_SRC, 'CURVES'), opts);
  delete globalThis.BAS;
  new Function(Deno.readTextFileSync(new URL('../src/content/00-ns.js', import.meta.url)))();
  const def = globalThis.BAS.DEFAULT_SETTINGS.volumeCurve;
  assert(opts.includes(def));
  for (const src of [CURVE_SRC, SETTINGS_SRC]) assertEquals(+/const DEFAULT_EXPONENT = ([\d.]+)/.exec(src)[1], def);
  const m = JSON.parse(Deno.readTextFileSync(new URL('../manifest.json', import.meta.url)));
  const by = (f) => m.content_scripts.find((c) => c.js.includes(f));
  for (const f of ['src/volume-curve.js', 'src/volume-settings.js']) assertEquals(by(f).matches, ['https://www.bilibili.com/*', 'https://live.bilibili.com/*']);
  assertEquals(by('src/volume-curve.js').world, 'MAIN');
  // the ad skipper also on the localized routes bilibili serves the player on (/zh-Hans/video/…)
  for (const f of ['src/page-bridge.js', 'src/content/00-ns.js']) assert(by(f).matches.includes('https://www.bilibili.com/*/video/*'), f);
});
