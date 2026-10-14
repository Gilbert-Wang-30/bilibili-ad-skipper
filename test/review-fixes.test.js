// Regression tests for fixes made after the multi-lens code review.
import { assert, assertEquals, assertStrictEquals } from './assert.js';
import { loadApi, makeFakeChrome } from './api-helpers.js';
import { loadBAS } from './load.js';

let BAS;
try { BAS = loadBAS(); } catch (_e) { BAS = loadApi(); }

class FakeVideo {
  constructor() { this._t = 0; this.duration = 1000; this.paused = false; this.ended = false; this.seeking = false; this.readyState = 4; this.seeks = []; this._l = new Map(); }
  get currentTime() { return this._t; }
  set currentTime(v) { this._t = v; this.seeks.push(v); }
  addEventListener(t, fn) { if (!this._l.has(t)) this._l.set(t, new Set()); this._l.get(t).add(fn); }
  removeEventListener(t, fn) { const s = this._l.get(t); if (s) s.delete(fn); }
  emit(t) { const s = this._l.get(t); if (s) for (const fn of [...s]) fn({ type: t, target: this }); }
  /** Simulate playback reaching t (no seek recorded). */
  play(t) { this._t = t; this.emit('timeupdate'); }
}
const seg = (id, start, end, extra) => Object.assign({ id, start, end, source: 'danmaku', sources: ['danmaku'], confidence: 0.9, autoSkip: true, enabled: true, reason: 'r' }, extra);

function mkSkipper(video, segments, settings, hooks = {}) {
  const s = Object.assign({}, BAS.DEFAULT_SETTINGS, settings);
  return new BAS.Skipper(video, { getSegments: () => segments, getSettings: () => s, ...hooks });
}

Deno.test('skipper: negative landing offset does not flash the skip button after an auto skip', () => {
  const v = new FakeVideo();
  let entered = 0;
  const sk = mkSkipper(v, [seg('d:100-200', 100, 200)], { landingOffsetSec: -3 }, { onEnter: () => entered++ });
  try {
    v.play(101);
    assertEquals(v.seeks, [197]);
    v.play(197.2);                     // landed inside the segment (end - 3)
    v.play(198);
    assertStrictEquals(entered, 0);
    assertEquals(v.seeks, [197]);      // no second skip either
  } finally { sk.destroy(); }
});

Deno.test('skipper: undo works while the skip seek is still in flight', () => {
  const v = new FakeVideo();
  const sk = mkSkipper(v, [seg('d:100-200', 100, 200)], {});
  try {
    v.play(105);
    assertEquals(v.seeks, [200]);
    v.seeking = true;                  // our own seek has not completed yet
    assert(sk.undo(), 'undo must issue the seek back');
    assertEquals(v.seeks, [200, 105]);
  } finally { sk.destroy(); }
});

Deno.test('skipper: undo(seg, from) undoes that specific (older) skip', () => {
  const v = new FakeVideo();
  const a = seg('d:100-200', 100, 200), b = seg('d:400-450', 400, 450);
  const sk = mkSkipper(v, [a, b], {});
  try {
    v.play(101); v.play(200.5); v.play(402);       // two skips; lastSkip is b
    assertEquals(v.seeks, [200, 450]);
    assert(sk.undo(a, 101));
    assertEquals(v.seeks.at(-1), 101);
    assert(sk.isSuppressed(a));
    assert(sk.lastSkip && sk.lastSkip.seg === b, 'the newer skip stays undoable');
  } finally { sk.destroy(); }
});

Deno.test('fusion: segment ids stay stable when media cuts re-snap the edges', () => {
  const cand = { start: 300.4, end: 360.6, source: 'danmaku', confidence: 0.9, reason: 'x' };
  const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
  const a = BAS.fuse({ candidates: [Object.assign({}, cand)], duration: 1000, boundaries: [], media: null, settings: S });
  const media = { nearestCut: (t) => ({ t: t + 2.7, strength: 1 }) };
  const b = BAS.fuse({ candidates: [Object.assign({}, cand)], duration: 1000, boundaries: [], media, settings: S });
  assertEquals(a[0].id, 'd:300-361');
  assertEquals(b[0].id, a[0].id);
  assert(Math.abs(b[0].start - 303.1) < 0.05, 'edges are still snapped');
  assert(!('_id0' in b[0]) && !('_id1' in b[0]), 'internal fields are not leaked');
});

Deno.test('storage.removeIgnore restores a segment the user ignored', async () => {
  const fake = makeFakeChrome();
  globalThis.chrome = fake;
  try {
    const St = BAS.storage;
    await St.addIgnore('BVx', 1, { start: 252.4, end: 360 });
    await St.addIgnore('BVx', 1, { start: 900, end: 960 });
    let ov = await St.getOverrides('BVx', 1);
    assertEquals(ov.ignore.length, 2);
    ov = await St.removeIgnore('BVx', 1, { start: 253, end: 347 });   // fused range differs slightly from the stored one
    assertEquals(ov.ignore, [{ start: 900, end: 960 }]);
    assertEquals((await St.getOverrides('BVx', 1)).ignore, [{ start: 900, end: 960 }]);
  } finally { delete globalThis.chrome; BAS.storage.__resetMemory(); }
});
