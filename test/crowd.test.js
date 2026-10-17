// Crowd-marked segments (BilibiliSponsorBlock) — 39-detect-crowd.js, the hash-prefix lookup in 22-api.js, fusion.
import { assert } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
// the API layer is not part of the pure bundle: evaluate it on top (it only defines functions at load)
if (!BAS.api) new Function(Deno.readTextFileSync(new URL('../src/content/22-api.js', import.meta.url)))();
const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
const seg = (a, b, extra) => Object.assign({ segment: [a, b], cid: '111', UUID: 'u', category: 'sponsor', actionType: 'skip', locked: 0, votes: 0, videoDuration: 600 }, extra);

Deno.test('detectCrowd: confidence from votes/lock; other parts, other cuts, disputed and downvoted marks', () => {
  const v = { cid: 111, duration: 600 };
  const r = BAS.detectCrowd([
    seg(100, 160), seg(200, 260, { votes: 3 }), seg(300, 340, { locked: 1 }), seg(400, 430, { votes: -1 }),
    seg(10, 50, { votes: -2 }), seg(500, 560, { cid: '222', videoDuration: 1200 }), seg(520, 580, { videoDuration: 640 }),
    seg(1, 3), seg(50, 90, { category: 'intro' }), seg(60, 99, { actionType: 'mute' }),
  ], v);
  const c = r.candidates.map((x) => [x.start, x.end, x.confidence]);
  assert(JSON.stringify(c) === JSON.stringify([[100, 160, 0.9], [200, 260, 0.95], [300, 340, 0.98], [400, 430, 0.5]]), JSON.stringify(c));
  assert(r.candidates.every((x) => x.source === 'crowd' && x.sources[0] === 'crowd'), 'source');
  // a mark under the old cid of a re-uploaded file of the same length still counts
  const other = [seg(100, 160, { cid: '999', videoDuration: 601 })];
  assert(BAS.detectCrowd(other, Object.assign({ parts: 1 }, v)).candidates.length === 1, 'single-part video, same length, other cid (file replaced) → kept');
  assert(BAS.detectCrowd(other, Object.assign({ parts: 3 }, v)).candidates.length === 0, 'multi-part video: another part of equal length → ignored');
  assert(BAS.detectCrowd(other, v).candidates.length === 0, 'part count unknown → another cid is not trusted');
  const nocid = [seg(100, 160, { cid: '', videoDuration: 0 })];
  assert(BAS.detectCrowd(nocid, Object.assign({ parts: 2 }, v)).candidates.length === 0 && BAS.detectCrowd(nocid, Object.assign({ parts: 1 }, v)).candidates.length === 1, 'a mark without cid or length only on single-part videos');
  const disputed = BAS.detectCrowd([seg(100, 160, { votes: -1 })], v).candidates[0];
  assert(disputed.offerOnly === true, 'a disputed mark is an offer');
  assert(BAS.detectCrowd(null, v).candidates.length === 0 && BAS.detectCrowd([{}], v).candidates.length === 0, 'garbage tolerated');
  const clipped = BAS.detectCrowd([seg(590, 640, { videoDuration: 0 })], v).candidates[0];
  assert(clipped && clipped.end === 600, 'clipped to the duration');
});

Deno.test('getCrowdSegments: only a 4-hex sha256 prefix leaves, via the background worker; 404 means none', async () => {
  const prev = globalThis.chrome;
  const msgs = [];
  let reply = null;
  globalThis.chrome = { runtime: { id: 'x', lastError: undefined, sendMessage: async (m) => { msgs.push(m); return reply(m); } } };
  try {
    const bv = 'BV1jCJs6UE9S';
    const full = await BAS.api.sha256Hex(bv);
    reply = () => ({ ok: true, status: 200, json: [{ videoID: 'BV1other', segments: [seg(1, 9)] }, { videoID: bv, segments: [seg(253.1, 360.6)] }] });
    const got = await BAS.api.getCrowdSegments(bv);
    assert(got.length === 1 && got[0].segment[0] === 253.1, 'segments of this video only: ' + JSON.stringify(got));
    const url = msgs[0].url;
    assert(msgs[0].type === 'BAS_FETCH' && url.startsWith('https://bsbsb.top/api/skipSegments/' + full.slice(0, 4) + '?'), url);
    assert(!url.includes(bv) && !url.includes(full.slice(0, 5)), 'neither the id nor more of the hash is sent: ' + url);
    reply = () => ({ ok: false, status: 404 });
    assert((await BAS.api.getCrowdSegments(bv)).length === 0, '404 → none');
    reply = () => ({ ok: true, status: 200, json: [{ videoID: 'BV1other', segments: [] }] });
    assert((await BAS.api.getCrowdSegments(bv)).length === 0, 'bucket without this video → none');
    reply = () => ({ ok: false, status: 503 });
    let err = null; try { await BAS.api.getCrowdSegments(bv); } catch (e) { err = e; }
    assert(err && err.status === 503, 'server errors surface (the orchestrator ignores them)');
  } finally { if (prev === undefined) delete globalThis.chrome; else globalThis.chrome = prev; }
});

Deno.test('fusion: a danmaku estimate overlapping a crowd mark merges into it and keeps the mark\'s edges', () => {
  const crowd = BAS.detectCrowd([seg(253.1, 360.6, { videoDuration: 2465 })], { cid: 111, duration: 2465 }).candidates[0];
  const dm = { source: 'danmaku', start: 254.8, end: 365, confidence: 0.7, reason: '弹幕', evidence: {} };
  const segs = BAS.buildSegments({ candidates: [crowd, dm], duration: 2465, settings: S }).segments;
  assert(segs.length === 1, 'one segment: ' + JSON.stringify(segs));
  assert(segs[0].start === 253.1 && segs[0].end === 360.6 && segs[0].autoSkip, 'crowd edges, auto-skip: ' + JSON.stringify(segs[0]));
  assert(segs[0].sources.includes('crowd') && segs[0].sources.includes('danmaku') && segs[0].confidence >= 0.95, 'corroborated');
  const off = BAS.buildSegments({ candidates: [crowd], duration: 2465, settings: Object.assign({}, S, { useCrowd: false }) }).segments;
  assert(off.length === 0, 'setting off → no crowd segment');
  const disputed = BAS.detectCrowd([seg(100, 160, { votes: -1 })], { cid: 111, duration: 600 }).candidates;
  assert(!BAS.buildSegments({ candidates: disputed, duration: 600, settings: S }).segments[0].autoSkip, 'a disputed mark is only offered');
});

Deno.test('fusion: a crowd mark absorbs weak or offer-only estimates that touch it instead of being stretched by them', () => {
  const mk = (a, b, votes = 0) => BAS.detectCrowd([seg(a, b, { votes, videoDuration: 1200 })], { cid: 111, duration: 1200 }).candidates[0];
  // review cases: an opening offer 0–60 touching a mark 59–85; a weak estimate 81–352.8 touching a mark 57–117
  const offer = { source: 'danmaku', start: 0, end: 60, confidence: 0.5, offerOnly: true, reason: '', evidence: {} };
  let segs = BAS.buildSegments({ candidates: [mk(59, 85), offer], duration: 1200, settings: S }).segments.filter((x) => x.autoSkip);
  assert(segs.length === 1 && segs[0].start === 59 && segs[0].end === 85, 'opening offer not merged into an auto-skip from 0:00: ' + JSON.stringify(segs.map((x) => [x.start, x.end])));
  const weak = { source: 'danmaku', start: 81, end: 352.8, confidence: 0.49, reason: '', evidence: {} };
  segs = BAS.buildSegments({ candidates: [mk(57.3, 117), weak], duration: 1200, settings: S }).segments.filter((x) => x.autoSkip);
  assert(segs.length === 1 && segs[0].start === 57.3 && segs[0].end === 117, 'weak estimate absorbed: ' + JSON.stringify(segs.map((x) => [x.start, x.end])));
  // the +0.05 for agreeing danmaku is applied once, however many estimates merge
  const est = (a, b) => ({ source: 'danmaku', start: a, end: b, confidence: 0.8, reason: '', evidence: {} });
  segs = BAS.buildSegments({ candidates: [mk(100, 200, -1), est(102, 198), est(105, 195), est(110, 190)], duration: 1200, settings: Object.assign({}, S, { minConfidence: 0.5 }) }).segments;
  assert(segs.length === 1 && segs[0].confidence <= 0.85 + 1e-9, 'one corroboration bonus: ' + JSON.stringify(segs.map((x) => [x.start, x.end, x.confidence])));
});

Deno.test('pipeline: crowd off ignores crowd candidates; no media download for estimates a crowd mark decides', () => {
  const mark = BAS.detectCrowd([seg(100, 160, { videoDuration: 600 })], { cid: 111, duration: 600 }).candidates[0];
  const est = { source: 'danmaku', start: 101, end: 159, confidence: 0.55, reason: '', evidence: { adVocab: 1 } };
  const est2 = { source: 'danmaku', start: 300, end: 360, confidence: 0.55, reason: '', evidence: { adVocab: 1 } };
  const on = BAS.buildSegments({ candidates: [mark, est, est2], duration: 600, settings: Object.assign({}, S, { useAvProbe: true }) });
  assert(on.avWanted.length === 1 && on.avWanted[0].start === 300, 'only the undecided estimate is probed: ' + JSON.stringify(on.avWanted.map((c) => c.start)));
  const off = BAS.buildSegments({ candidates: [mark], duration: 600, settings: Object.assign({}, S, { useCrowd: false }) });
  assert(off.segments.length === 0 && off.dropped.length === 0, 'crowd off → no trace of the mark');
});

Deno.test('getCrowdSegments: gives up after the timeout and honours abort', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = { runtime: { id: 'x', lastError: undefined, sendMessage: () => new Promise(() => {}) } };
  try {
    let err = null; const t0 = Date.now();
    try { await BAS.api.getCrowdSegments('BV1jCJs6UE9S', { timeoutMs: 50 }); } catch (e) { err = e; }
    assert(err && Date.now() - t0 < 1000, 'timeout: ' + (err && err.message));
    const ac = new AbortController();
    const p = BAS.api.getCrowdSegments('BV1jCJs6UE9S', { signal: ac.signal, timeoutMs: 10000 }).catch((e) => e);
    ac.abort();
    const e2 = await p;
    assert(e2 && e2.name === 'AbortError', 'abort: ' + (e2 && e2.name));
  } finally { if (prev === undefined) delete globalThis.chrome; else globalThis.chrome = prev; }
});

Deno.test('settings: an existing A/V opt-out also turns the skip button media download off', () => {
  const st = BAS.storage;
  if (!st || !st.sanitizeSettings) return;
  assert(st.sanitizeSettings({ useAvProbe: false }).skipHereMedia === false, 'opt-out carried over');
  assert(st.sanitizeSettings({}).skipHereMedia === true && st.sanitizeSettings({ useAvProbe: false, skipHereMedia: true }).skipHereMedia === true, 'defaults / explicit choice kept');
});
