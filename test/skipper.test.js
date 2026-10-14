// Tests for src/content/40-skipper.js (BAS.Skipper)
import { ok as assert, deepStrictEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert';
import { loadBAS } from './load.js';

function bas() {
  try { return loadBAS(); } catch (_e) { return loadBAS(['00-ns.js', '30-detect-chapters.js', '33-fusion.js', '40-skipper.js']); }
}
const BAS = bas();

/** Minimal HTMLVideoElement stand-in. Setting currentTime records a seek and fires seeking/seeked synchronously. */
class FakeVideo {
  constructor(duration = 600) {
    this._t = 0;
    this.duration = duration;
    this.paused = false;
    this.seeking = false;
    this.readyState = 4;
    this.ended = false;
    this.listeners = new Map();
    this.seeks = [];
  }
  get currentTime() { return this._t; }
  set currentTime(v) {
    this.seeks.push(v);
    this._t = v;
    this.seeking = true;
    this.dispatchEvent({ type: 'seeking' });
    this.seeking = false;
    this.dispatchEvent({ type: 'seeked' });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { const s = this.listeners.get(type); if (s) s.delete(fn); }
  dispatchEvent(ev) { const s = this.listeners.get(ev.type); if (s) for (const fn of Array.from(s)) fn(ev); return true; }
  listenerCount() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
  /** Playback advances to t and fires timeupdate. */
  play(t) { this._t = t; this.dispatchEvent({ type: 'timeupdate' }); }
  /** The user drags the progress bar to t (not recorded in `seeks`). */
  userSeek(t) {
    this._t = t;
    this.seeking = true;
    this.dispatchEvent({ type: 'seeking' });
    this.seeking = false;
    this.dispatchEvent({ type: 'seeked' });
    this.dispatchEvent({ type: 'timeupdate' });
  }
}

const seg = (id, start, end, extra) => Object.assign({ id, start, end, source: 'danmaku', sources: ['danmaku'], confidence: 0.9, reason: '弹幕', autoSkip: true, enabled: true }, extra);

function harness(video, segments, settings) {
  const calls = { skip: [], enter: [], leave: [] };
  const state = { segments, settings: Object.assign({}, BAS.DEFAULT_SETTINGS, settings) };
  const skipper = new BAS.Skipper(video, {
    getSegments: () => state.segments,
    getSettings: () => state.settings,
    onSkip: (s, from) => calls.skip.push([s.id, from]),
    onEnter: (s) => calls.enter.push(s.id),
    onLeave: (s) => calls.leave.push(s.id),
  });
  return { skipper, calls, state };
}

/** Wrap setInterval/clearInterval to observe the Skipper's timer. Restores on dispose(). */
function trackTimers() {
  const origSet = globalThis.setInterval, origClear = globalThis.clearInterval;
  const rec = { set: [], cleared: [] };
  globalThis.setInterval = (fn, ms, ...rest) => { const id = origSet(fn, ms, ...rest); rec.set.push({ id, fn, ms }); return id; };
  globalThis.clearInterval = (id) => { rec.cleared.push(id); return origClear(id); };
  rec.dispose = () => { globalThis.setInterval = origSet; globalThis.clearInterval = origClear; };
  return rec;
}

Deno.test('Skipper: auto-skips once when entering a segment, then not again until it leaves', () => {
  const v = new FakeVideo(600);
  const { skipper, calls } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.play(50);
    assertEquals(v.seeks, []);
    v.play(100.5);
    assertEquals(v.seeks, [160]);
    assertEquals(calls.skip, [['d:100-160', 100.5]]);
    assertEquals(skipper.lastSkip.from, 100.5);
    // timeupdate after landing: no further seek
    v.play(160.3);
    v.play(161);
    assertEquals(v.seeks, [160]);
    assertEquals(calls.enter, []);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: no re-skip after undo(); suppression lifts after leaving by > 2 s', () => {
  const v = new FakeVideo(600);
  const { skipper, calls } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.play(101);
    assertEquals(v.seeks, [160]);
    assert(skipper.undo());
    assertEquals(v.seeks, [160, 101]);
    assertStrictEquals(skipper.lastSkip, null);
    assert(skipper.isSuppressed({ id: 'd:100-160' }));
    // watching the ad: no seeks
    v.play(102); v.play(130); v.play(159);
    assertEquals(v.seeks, [160, 101]);
    assertEquals(calls.skip.length, 1);
    // after leaving by > 2 s the suppression is cleared
    v.play(163);
    assert(!skipper.isSuppressed({ id: 'd:100-160' }));
    // a user seek back inside suppresses again (not an auto re-skip)
    v.userSeek(120);
    assertEquals(v.seeks, [160, 101]);
    assertEquals(calls.skip.length, 1);
    // undo without a last skip is a no-op
    assertStrictEquals(skipper.undo(), false);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: user seeking into a segment suppresses skipping until playback leaves it by > 2 s', () => {
  const v = new FakeVideo(600);
  const { skipper, calls } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.userSeek(120);
    v.play(121); v.play(140);
    assertEquals(v.seeks, []);
    assertEquals(calls.skip, []);
    v.play(161.5);                // left, but not by > 2 s yet
    assert(skipper.isSuppressed({ id: 'd:100-160' }));
    v.play(162.5);                // now > 2 s past the end
    assert(!skipper.isSuppressed({ id: 'd:100-160' }));
    // natural re-entry (e.g. a loop) skips again
    v.play(105);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: a user seek that lands outside any segment does not suppress', () => {
  const v = new FakeVideo(600);
  const { skipper } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.userSeek(90);
    v.play(100);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: manual mode calls onEnter/onLeave and skipNow() seeks', () => {
  const v = new FakeVideo(600);
  const s1 = seg('d:100-160', 100, 160);
  const { skipper, calls } = harness(v, [s1], { mode: 'manual' });
  try {
    v.play(50);
    assertEquals(calls.enter, []);
    v.play(100); v.play(110); v.play(120);
    assertEquals(calls.enter, ['d:100-160']);   // once per entry
    assertEquals(calls.leave, []);
    assertEquals(v.seeks, []);
    assertStrictEquals(skipper.currentSegment, s1);
    assert(skipper.skipNow(s1));
    assertEquals(v.seeks, [160]);
    assertEquals(calls.leave, ['d:100-160']);
    assertEquals(calls.skip, [['d:100-160', 120]]);
    v.play(165);
    assertEquals(calls.leave, ['d:100-160']);
    // re-entry later (after suppression expired) enters again
    v.play(170);
    v.userSeek(130);
    assertEquals(calls.enter, ['d:100-160', 'd:100-160']);
    v.play(161);
    assertEquals(calls.leave, ['d:100-160', 'd:100-160']);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: low-confidence (autoSkip=false) and offerOnly segments use the button path in auto mode', () => {
  const v = new FakeVideo(600);
  const { skipper, calls } = harness(v, [seg('d:100-160', 100, 160, { autoSkip: false, confidence: 0.4 }), seg('d:0-60', 0, 60, { autoSkip: false, offerOnly: true })]);
  try {
    v.play(10);
    assertEquals(calls.enter, ['d:0-60']);
    v.play(70);
    assertEquals(calls.leave, ['d:0-60']);
    v.play(110);
    assertEquals(calls.enter, ['d:0-60', 'd:100-160']);
    assertEquals(v.seeks, []);
    // a disabled segment is ignored entirely
    v.play(170);
    assertEquals(calls.leave, ['d:0-60', 'd:100-160']);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: disabled segments and settings.enabled=false are ignored', () => {
  const v = new FakeVideo(600);
  const { skipper, state } = harness(v, [seg('d:100-160', 100, 160, { enabled: false })]);
  try {
    v.play(110);
    assertEquals(v.seeks, []);
    state.segments = [seg('d:100-160', 100, 160)];
    state.settings = Object.assign({}, state.settings, { enabled: false });
    v.play(111);
    assertEquals(v.seeks, []);
    state.settings = Object.assign({}, state.settings, { enabled: true });
    v.play(112);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: landingOffsetSec is applied and clamped to duration - 0.5', () => {
  const v = new FakeVideo(600);
  const { skipper, state } = harness(v, [seg('d:100-160', 100, 160), seg('d:580-599', 580, 599)], { landingOffsetSec: 1.5 });
  try {
    v.play(100);
    assertEquals(v.seeks, [161.5]);
    v.play(585);
    assertEquals(v.seeks, [161.5, 599.5]);
    // negative offsets never land back inside the segment start (no loop)
    state.settings = Object.assign({}, state.settings, { landingOffsetSec: -100 });
    v.play(300);
    v.play(100);
    assertEquals(v.seeks[2], 100);
    v.play(101);
    assertEquals(v.seeks.length, 3);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: no seek while video.seeking or readyState < 1', () => {
  const v = new FakeVideo(600);
  const { skipper } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.seeking = true;
    v.play(110);
    assertEquals(v.seeks, []);
    v.seeking = false;
    v.readyState = 0;
    v.play(111);
    assertEquals(v.seeks, []);
    assertStrictEquals(skipper.skipNow(seg('d:100-160', 100, 160)), false);
    v.readyState = 1;
    v.play(112);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: segment must satisfy start <= t < end - 0.3', () => {
  const v = new FakeVideo(600);
  const { skipper } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.play(99.9);
    v.play(159.8);
    assertEquals(v.seeks, []);
    v.play(159.6);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: attach(newVideo) moves listeners to the new element', () => {
  const v1 = new FakeVideo(600), v2 = new FakeVideo(600);
  const { skipper, calls } = harness(v1, [seg('d:100-160', 100, 160)]);
  try {
    assertEquals(v1.listenerCount(), 2);
    assertEquals(v2.listenerCount(), 0);
    skipper.attach(v2);
    assertEquals(v1.listenerCount(), 0);
    assertEquals(v2.listenerCount(), 2);
    assertStrictEquals(skipper.video, v2);
    v1.play(110);                       // old element no longer drives skips
    assertEquals(v1.seeks, []);
    v2.play(110);
    assertEquals(v2.seeks, [160]);
    assertEquals(calls.skip.length, 1);
    skipper.attach(v2);                 // idempotent
    assertEquals(v2.listenerCount(), 2);
    skipper.attach(null);
    assertEquals(v2.listenerCount(), 0);
    assertStrictEquals(skipper.skipNow(seg('d:100-160', 100, 160)), false);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: reset() clears suppression and lastSkip for a new video', () => {
  const v = new FakeVideo(600);
  const { skipper } = harness(v, [seg('d:100-160', 100, 160)]);
  try {
    v.userSeek(120);
    assert(skipper.isSuppressed({ id: 'd:100-160' }));
    skipper.reset();
    assert(!skipper.isSuppressed({ id: 'd:100-160' }));
    assertStrictEquals(skipper.lastSkip, null);
    v.play(121);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});

Deno.test('Skipper: 250 ms setInterval guard drives skips and is cleared by destroy() with listeners removed', () => {
  const rec = trackTimers();
  const v = new FakeVideo(600);
  let skipper;
  try {
    const h = harness(v, [seg('d:100-160', 100, 160)]);
    skipper = h.skipper;
    assertEquals(rec.set.length, 1);
    assertEquals(rec.set[0].ms, 250);
    // Playback position moved without a timeupdate event (e.g. throttled background tab): the interval catches it.
    v._t = 120;
    rec.set[0].fn();
    assertEquals(v.seeks, [160]);
    assertEquals(h.calls.skip.length, 1);
    assertEquals(v.listenerCount(), 2);
    skipper.destroy();
    assertEquals(rec.cleared, [rec.set[0].id]);
    assertEquals(v.listenerCount(), 0);
    assertStrictEquals(skipper.video, null);
    // after destroy nothing reacts
    v._t = 130;
    rec.set[0].fn();
    v.play(131);
    assertEquals(v.seeks, [160]);
    assertStrictEquals(skipper.skipNow(seg('d:100-160', 100, 160)), false);
    assertStrictEquals(skipper.undo(), false);
    skipper.destroy(); // idempotent
    assertEquals(rec.cleared.length, 1);
  } finally {
    if (skipper) skipper.destroy();
    rec.dispose();
  }
});

Deno.test('Skipper: callbacks and getters that throw do not break the loop', () => {
  const v = new FakeVideo(600);
  let n = 0;
  const skipper = new BAS.Skipper(v, {
    getSegments: () => { if (n++ === 0) throw new Error('boom'); return [seg('d:100-160', 100, 160)]; },
    getSettings: () => { throw new Error('boom'); },
    onSkip: () => { throw new Error('boom'); },
  });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    v.play(110);        // getSegments throws -> nothing
    assertEquals(v.seeks, []);
    v.play(111);        // settings fall back to BAS.state.settings (auto) -> skip; onSkip throws but is caught
    assertEquals(v.seeks, [160]);
  } finally { console.warn = origWarn; skipper.destroy(); }
});

Deno.test('Skipper: constructing without a video and attaching later works', () => {
  const skipper = new BAS.Skipper(null, { getSegments: () => [seg('d:100-160', 100, 160)] });
  const v = new FakeVideo(600);
  try {
    assertStrictEquals(skipper.video, null);
    skipper.attach(v);
    v.play(110);
    assertEquals(v.seeks, [160]);
  } finally { skipper.destroy(); }
});
