import { assert, assertEquals, assertStrictEquals } from './assert.js';
import { loadApi, makeFakeChrome, tick } from './api-helpers.js';

const BAS = loadApi();
const S = BAS.storage;

/** Run fn with a fake chrome.storage installed on globalThis, then remove it. */
async function withFakeChrome(fn) {
  const fake = makeFakeChrome();
  globalThis.chrome = fake;
  try { await fn(fake); }
  finally { delete globalThis.chrome; S.__resetMemory(); BAS.state.settings = Object.assign({}, BAS.DEFAULT_SETTINGS); }
}

Deno.test('storage: in-memory fallback when chrome is undefined', async () => {
  assertStrictEquals(typeof globalThis.chrome, 'undefined');
  S.__resetMemory();
  assertEquals(S.isPersistent(), false);
  const s = await S.loadSettings();
  assertEquals(s, BAS.DEFAULT_SETTINGS);
  assertStrictEquals(BAS.state.settings, s);
  await S.saveSettings({ mode: 'manual', minConfidence: 0.8 });
  const s2 = await S.loadSettings();
  assertEquals(s2.mode, 'manual');
  assertEquals(s2.minConfidence, 0.8);
  assertEquals(s2.enabled, true);
  await S.setCache(123, { segments: [{ start: 1, end: 2 }], candidates: [] });
  assertEquals((await S.getCache(123)).segments, [{ start: 1, end: 2 }]);
  // listener fires on the memory backend too
  let seen = null;
  const off = S.onSettingsChanged((m) => { seen = m; });
  await S.saveSettings({ debug: true });
  assertEquals(seen && seen.debug, true);
  off();
  await S.saveSettings({ debug: false });
  assertEquals(seen.debug, true);
  S.__resetMemory();
  BAS.state.settings = Object.assign({}, BAS.DEFAULT_SETTINGS);
});

Deno.test('storage.settings: save/load via chrome.storage.sync, sanitising, change events', () =>
  withFakeChrome(async (fake) => {
    assertEquals(S.isPersistent(), true);
    assertEquals(await S.loadSettings(), BAS.DEFAULT_SETTINGS);
    const saved = await S.saveSettings({ mode: 'manual', extraStartKeywords: ['恰饭时间', ' 广子 ', ''], ignoreUps: [123, '456'], landingOffsetSec: 2 });
    assertEquals(saved.mode, 'manual');
    assertEquals(saved.extraStartKeywords, ['恰饭时间', '广子']);
    assertEquals(saved.ignoreUps, [123, '456']);
    assertEquals(fake.storage.sync._data.get('settings').mode, 'manual');
    assertStrictEquals(BAS.state.settings, saved);
    // partial update keeps the earlier keys
    await S.saveSettings({ minConfidence: 0.7 });
    const loaded = await S.loadSettings();
    assertEquals(loaded.mode, 'manual');
    assertEquals(loaded.minConfidence, 0.7);
    assertEquals(loaded.landingOffsetSec, 2);
    // garbage types are coerced back to defaults / clamped
    fake.storage.sync._data.set('settings', { enabled: 'yes', mode: 'weird', minConfidence: 7, extraEndKeywords: 'notalist', toastDurationMs: '2500', ignoreUps: null, unknownKey: 1 });
    const fixed = await S.loadSettings();
    assertEquals(fixed.enabled, true);
    assertEquals(fixed.mode, 'auto');
    assertEquals(fixed.minConfidence, 1);
    assertEquals(fixed.extraEndKeywords, []);
    assertEquals(fixed.toastDurationMs, 2500);
    assertEquals(fixed.ignoreUps, []);
    assertEquals(fixed.unknownKey, 1);
    // change events (e.g. options page writes in another context)
    const got = [];
    const off = S.onSettingsChanged((m, ch) => got.push([m, ch]));
    await fake.storage.sync.set({ settings: { mode: 'manual', showToast: false } });
    await tick();
    assertEquals(got.length, 1);
    assertEquals(got[0][0].showToast, false);
    assertEquals(got[0][0].mode, 'manual');
    assertEquals(got[0][0].enabled, true);          // merged with defaults
    assertEquals(BAS.state.settings.showToast, false);
    await fake.storage.local.set({ settings: { mode: 'auto' } });   // wrong area → ignored
    await fake.storage.sync.set({ other: 1 });                        // other key → ignored
    await tick();
    assertEquals(got.length, 1);
    off();
    await fake.storage.sync.set({ settings: { mode: 'auto' } });
    await tick();
    assertEquals(got.length, 1);
    assertEquals(await S.resetSettings(), BAS.DEFAULT_SETTINGS);
  }));

Deno.test('storage.overrides: per-video ignore/add ranges', () =>
  withFakeChrome(async (fake) => {
    assertEquals(await S.getOverrides('BV1xx', 100), { ignore: [], add: [], ts: 0 });
    const o1 = await S.addIgnore('BV1xx', 100, { start: 252.04, end: 360 });
    assertEquals(o1.ignore, [{ start: 252, end: 360 }]);
    assert(o1.ts > 0);
    await S.addIgnore('BV1xx', 100, 252.2, 360.3);        // duplicate (within 0.5 s) → not added
    await S.addUser('BV1xx', 100, 10, 40);
    const o2 = await S.getOverrides('BV1xx', 100);
    assertEquals(o2.ignore, [{ start: 252, end: 360 }]);
    assertEquals(o2.add, [{ start: 10, end: 40 }]);
    assert(fake.storage.local._data.has('v:BV1xx:100'));
    // invalid ranges are ignored (and warned), state unchanged
    const o3 = await S.addIgnore('BV1xx', 100, 50, 20);
    assertEquals(o3.ignore.length, 1);
    await S.addUser('BV1xx', 100, NaN, 5);
    assertEquals((await S.getOverrides('BV1xx', 100)).add.length, 1);
    // adding a user segment identical to an ignore removes the ignore (and vice versa)
    await S.addUser('BV1xx', 100, 252, 360);
    const o4 = await S.getOverrides('BV1xx', 100);
    assertEquals(o4.ignore, []);
    assertEquals(o4.add.length, 2);
    // other part untouched, clear works
    assertEquals((await S.getOverrides('BV1xx', 101)).add, []);
    await S.clearOverrides('BV1xx', 100);
    assertEquals(await S.getOverrides('BV1xx', 100), { ignore: [], add: [], ts: 0 });
    await S.addIgnore('BV1a', 1, 1, 2); await S.addIgnore('BV1b', 2, 1, 2);
    await S.setCache(5, { segments: [], candidates: [] });
    assertEquals(await S.clearAllOverrides(), 2);
    assert(fake.storage.local._data.has('c:5'));
    // corrupted stored value → cleaned
    fake.storage.local._data.set('v:BV1z:9', { ignore: [{ start: 'a', end: 3 }, { start: 1, end: 3 }], add: 'nope' });
    assertEquals(await S.getOverrides('BV1z', 9), { ignore: [{ start: 1, end: 3 }], add: [], ts: 0 });
  }));

Deno.test('storage.cache: TTL, version check and LRU prune', () =>
  withFakeChrome(async (fake) => {
    const data = { segments: [{ id: 'danmaku:252-360', start: 252, end: 360 }], candidates: [{ start: 252, end: 360 }] };
    const entry = await S.setCache(777, data);
    assertEquals(entry.version, BAS.VERSION);
    assert(Date.now() - entry.ts < 1000);
    // a caller-supplied detection time is kept (A/V updates must not make stale results look fresh); future ones are not
    const old = Date.now() - 3 * 3600 * 1000;
    assertEquals((await S.setCache(779, Object.assign({ ts: old }, data))).ts, old);
    assert(Date.now() - (await S.setCache(780, Object.assign({ ts: Date.now() + 1e9 }, data))).ts < 1000);
    const hit = await S.getCache(777);
    assertEquals(hit.segments, data.segments);
    assertEquals(hit.candidates, data.candidates);
    assertEquals(await S.getCache(778), null);
    // expired → null and removed
    fake.storage.local._data.set('c:778', { segments: [], candidates: [], ts: Date.now() - S.CACHE_TTL_MS - 1, version: BAS.VERSION });
    assertEquals(await S.getCache(778), null);
    await tick();
    assert(!fake.storage.local._data.has('c:778'));
    // version mismatch → null (unless anyVersion)
    fake.storage.local._data.set('c:779', { segments: [1], candidates: [], ts: Date.now(), version: '0.0.0' });
    assertEquals(await S.getCache(779), null);
    fake.storage.local._data.set('c:779', { segments: [1], candidates: [], ts: Date.now(), version: '0.0.0' });
    assertEquals((await S.getCache(779, { anyVersion: true })).segments, [1]);
    // garbage entry
    fake.storage.local._data.set('c:780', 'garbage');
    assertEquals(await S.getCache(780), null);
    // prune: 310 live entries + 1 expired + 1 old version → keep newest 300 live
    fake.storage.local._data.clear();
    const now = Date.now();
    for (let i = 0; i < 310; i++) fake.storage.local._data.set(`c:${i}`, { segments: [], candidates: [], ts: now - i * 1000, version: BAS.VERSION });
    fake.storage.local._data.set('c:expired', { segments: [], candidates: [], ts: now - S.CACHE_TTL_MS - 5, version: BAS.VERSION });
    fake.storage.local._data.set('c:oldver', { segments: [], candidates: [], ts: now, version: 'x' });
    fake.storage.local._data.set('v:BV:1', { ignore: [], add: [], ts: now });
    const removed = await S.pruneCache();
    assertEquals(removed, 12);
    const keys = [...fake.storage.local._data.keys()];
    assertEquals(keys.filter((k) => k.startsWith('c:')).length, 300);
    assert(fake.storage.local._data.has('c:0'));
    assert(fake.storage.local._data.has('c:299'));
    assert(!fake.storage.local._data.has('c:300'));
    assert(!fake.storage.local._data.has('c:309'));
    assert(!fake.storage.local._data.has('c:expired'));
    assert(!fake.storage.local._data.has('c:oldver'));
    assert(fake.storage.local._data.has('v:BV:1'));
    // setCache runs the prune opportunistically (first call of a fresh counter)
    S.__resetMemory();   // resets the counter
    fake.storage.local._data.set('c:stale', { segments: [], candidates: [], ts: now - S.CACHE_TTL_MS - 5, version: BAS.VERSION });
    await S.setCache(1, { segments: [], candidates: [] });
    await tick(100);   // the opportunistic prune is fire-and-forget and takes a few storage round-trips
    assert(!fake.storage.local._data.has('c:stale'));
    assertEquals(await S.clearCache(), 300);   // c:1 was overwritten, not added
    assertEquals([...fake.storage.local._data.keys()].filter((k) => k.startsWith('c:')).length, 0);
  }));

Deno.test('storage.wbiKeys: 6 h TTL', () =>
  withFakeChrome(async (fake) => {
    assertEquals(await S.getWbiKeys(), null);
    await S.setWbiKeys({ imgKey: 'img', subKey: 'sub' });
    const k = await S.getWbiKeys();
    assertEquals(k.imgKey, 'img'); assertEquals(k.subKey, 'sub'); assert(typeof k.ts === 'number');
    fake.storage.local._data.set('wbiKeys', { imgKey: 'img', subKey: 'sub', ts: Date.now() - S.WBI_TTL_MS - 1 });
    assertEquals(await S.getWbiKeys(), null);
    await S.setWbiKeys({ imgKey: 123 });        // invalid → ignored
    assertEquals(await S.getWbiKeys(), null);
  }));

Deno.test('storage.exportData / importData round-trip', () =>
  withFakeChrome(async () => {
    await S.saveSettings({ mode: 'manual' });
    await S.addIgnore('BV1q', 7, 1, 9);
    const dump = await S.exportData();
    assertEquals(dump.settings.mode, 'manual');
    assertEquals(dump.overrides['v:BV1q:7'].ignore, [{ start: 1, end: 9 }]);
    await S.resetSettings();
    await S.clearAllOverrides();
    await S.importData(JSON.parse(JSON.stringify(dump)));
    assertEquals((await S.loadSettings()).mode, 'manual');
    assertEquals((await S.getOverrides('BV1q', 7)).ignore, [{ start: 1, end: 9 }]);
  }));

Deno.test('storage: survives a throwing chrome.storage (falls back to memory)', async () => {
  globalThis.chrome = { storage: { local: { get() { throw new Error('Extension context invalidated.'); }, set() { throw new Error('boom'); }, remove() { throw new Error('boom'); } }, sync: { get(_k, cb) { cb(undefined); }, set(_o, cb) { cb(); } } , onChanged: { addListener() {}, removeListener() {} } }, runtime: {} };
  const origWarn = BAS.warn; const warned = []; BAS.warn = (...a) => warned.push(a);
  try {
    assertEquals(await S.getOverrides('BV', 1), { ignore: [], add: [], ts: 0 });
    await S.addIgnore('BV', 1, 1, 2);
    assertEquals((await S.getOverrides('BV', 1)).ignore, [{ start: 1, end: 2 }]);
    assertEquals(await S.loadSettings(), BAS.DEFAULT_SETTINGS);
    assert(warned.length > 0);
  } finally { BAS.warn = origWarn; delete globalThis.chrome; S.__resetMemory(); }
});
