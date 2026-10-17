// Audio/video segment judgement (37-av-segment.js) and the ISO-BMFF / feature helpers of 36-media-probe.js.
import { assert } from './assert.js';
import { loadBAS, loadExpected, hasAvFixtures, loadAvFixture } from './load.js';

const BAS = loadBAS();
const AV = BAS.avSegment;
const HAS_AV = hasAvFixtures();

// ---- synthetic data: speech-like content (pauses, dim picture) around a loud, steady, bright "ad" with dip+cut edges
function synth({ t0 = 0, t1 = 300, adStart = 100, adEnd = 200, adLike = true, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const audio = [], video = [];
  for (let t = t0; t < t1; t += 0.25) {
    const inAd = adLike && t >= adStart && t < adEnd;
    let db = inAd ? -14 + rnd() * 2 : (rnd() < 0.25 ? -32 + rnd() * 4 : -19 + rnd() * 4);
    if (adLike && (Math.abs(t - (adStart - 0.25)) < 0.01 || Math.abs(t - (adEnd - 0.25)) < 0.01)) db = -42;
    audio.push({ t, db, flux: inAd ? 0.5 + rnd() * 0.2 : 0.3 + rnd() * 0.2 });
  }
  let prevCut = t0;
  for (let t = t0; t < t1; t += 0.25) {
    const inAd = adLike && t >= adStart && t < adEnd;
    let cut = rnd() * 4;
    if (t - prevCut > 2.5 + rnd() * 2) { cut = 45; prevCut = t; }
    if (adLike && (Math.abs(t - adStart) < 0.01 || Math.abs(t - adEnd) < 0.01)) cut = 95;
    video.push({ t, mean: inAd ? 150 + rnd() * 20 : 80 + rnd() * 20, cut, drift: cut });
  }
  return { t0, t1, audio, video };
}

Deno.test('synthetic: a loud, steady, bright segment with dip+cut edges is confirmed and its end snaps', () => {
  const d = synth();
  const r = AV.assess(d, 103, 194);
  assert(r.verdict === 'ad', 'verdict ad: ' + JSON.stringify(r));
  assert(Math.abs(r.end - 200) <= 0.5, 'end snapped to 200, got ' + r.end);
  assert(r.endBy === 'av', 'end refined by A/V');
  const n = AV.assess(synth({ adLike: false }), 100, 200);
  assert(n.verdict === 'notAd', 'plain content is not an ad: ' + JSON.stringify(n));
  assert(n.endBy === null, 'nothing to snap to in plain content');
  assert(AV.assess({ audio: [], video: [] }, 100, 200).verdict === 'unknown', 'no data → unknown');
});

Deno.test('synthetic: skip-here end finding, pending when the data stops before the end', () => {
  const d = synth();
  const f = AV.findEnd(d, 130);
  assert(f && !f.pending && Math.abs(f.t - 200) <= 0.5, 'end found at 200: ' + JSON.stringify(f));
  const part = { audio: d.audio.filter((x) => x.t < 170), video: d.video.filter((x) => x.t < 170) };
  const p = AV.findEnd(part, 130);
  assert(p && p.pending, 'pending without the end in view: ' + JSON.stringify(p));
  assert(AV.findEnd({ audio: [], video: [] }, 10) === null, 'no data → null');
});

Deno.test('synthetic: audio-only data still judges segments (no luma term)', () => {
  const d = synth();
  const r = AV.assess({ audio: d.audio, video: [] }, 103, 194);
  assert(r.verdict === 'ad', 'audio-only verdict ad: ' + JSON.stringify(r));
  assert(Math.abs(r.end - 199.75) <= 0.6, 'end snapped to the audio dip, got ' + r.end);
});

Deno.test('apply: notAd caps confidence; ad boosts candidates with evidence and locks refined edges', () => {
  const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
  const c1 = { source: 'danmaku', start: 100, end: 195, confidence: 0.55, reason: 'x', evidence: { targetsAgree: 1 } };
  const c2 = { source: 'danmaku', start: 400, end: 500, confidence: 0.8, reason: 'y', evidence: { targetsAgree: 4 } };
  const c3 = { source: 'chapter', start: 600, end: 700, confidence: 0.95, reason: 'z' };
  const m = new Map([
    [AV.key(c1), { verdict: 'ad', score: 2.1, start: 100, end: 200, startBy: null, endBy: 'av' }],
    [AV.key(c2), { verdict: 'notAd', score: 0.1, start: 400, end: 500, startBy: null, endBy: null }],
  ]);
  const [a, b, c] = AV.apply([c1, c2, c3], m, S);
  assert(a.confidence >= 0.6 && a.end === 200 && a.lockEnd && a.idEnd === 195 && a.sources.includes('media'), 'confirmed: ' + JSON.stringify(a));
  assert(b.confidence < S.minConfidence && b.end === 500, 'refuted below threshold: ' + JSON.stringify(b));
  assert(c === c3, 'chapters untouched');
  assert(c1.end === 195 && c1.confidence === 0.55, 'input not mutated');
  const noEv = AV.apply([{ source: 'danmaku', start: 100, end: 195, confidence: 0.45, evidence: {} }], new Map([['danmaku:100-195', { verdict: 'ad', score: 2, start: 100, end: 195 }]]), S)[0];
  assert(noEv.confidence === 0.45, 'no independent evidence → no boost');
  assert(AV.apply([c1], m, Object.assign({}, S, { useAvProbe: false }))[0] === c1, 'setting off → untouched');
});

Deno.test('fusion keeps A/V-locked edges and the pre-A/V id', () => {
  const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
  const cand = { source: 'danmaku', start: 101, end: 203.4, idStart: 100, idEnd: 195, lockEnd: true, confidence: 0.8, reason: '' };
  const segs = BAS.fuse({ candidates: [cand], duration: 900, boundaries: [198], settings: S });
  assert(segs.length === 1, 'one segment');
  assert(segs[0].end === 203.4, 'locked end not snapped to the chapter boundary: ' + segs[0].end);
  assert(segs[0].start === 101, 'unlocked start keeps its value (no boundary near)');
  assert(segs[0].id === 'd:100-195', 'id from the pre-A/V estimate: ' + segs[0].id);
  assert(!('lockEnd' in segs[0]) && !('idStart' in segs[0]), 'internal fields stripped');
});

Deno.test('ISO-BMFF: sidx and fragment parsing', () => {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type, body) => [...be32(8 + body.length), ...type.split('').map((c) => c.charCodeAt(0)), ...body];
  // sidx v0: ref id 1, timescale 1000, ept 0, first_offset 0, 2 refs (size 100 / 1000 ms, size 50 / 2000 ms)
  const sidx = box('sidx', [0, 0, 0, 0, ...be32(1), ...be32(1000), ...be32(0), ...be32(0), 0, 0, 0, 2, ...be32(100), ...be32(1000), ...be32(0x90000000), ...be32(50), ...be32(2000), ...be32(0x90000000)]);
  const r = BAS.mp4.parseSidx(new Uint8Array(sidx), 500);
  assert(r && r.segments.length === 2, 'two refs');
  assert(r.segments[0].offset === 500 + sidx.length && r.segments[1].offset === 500 + sidx.length + 100, 'offsets follow the sidx');
  assert(r.segments[1].start === 1 && r.segments[1].duration === 2, 'times in seconds');
  // moof(mfhd, traf(tfhd default-base-is-moof, tfdt v0 = 9000, trun: data offset, duration, size, flags)) + mdat
  const tfhd = box('tfhd', [0, 0x02, 0, 0, ...be32(1)]);
  const tfdt = box('tfdt', [0, 0, 0, 0, ...be32(9000)]);
  const trunBody = (off) => [0, 0, 0x07, 0x01, ...be32(2), ...be32(off), ...be32(512), ...be32(3), ...be32(0x02000000), ...be32(512), ...be32(4), ...be32(0x01010000)];
  const mfhd = box('mfhd', [0, 0, 0, 0, ...be32(1)]);
  const moofLen = 8 + mfhd.length + (8 + tfhd.length + tfdt.length + (8 + trunBody(0).length));
  const moof = box('moof', [...mfhd, ...box('traf', [...tfhd, ...tfdt, ...box('trun', trunBody(moofLen + 8))])]);
  const bytes = new Uint8Array([...moof, ...box('mdat', [1, 2, 3, 4, 5, 6, 7])]);
  const s = BAS.mp4.parseFragments(bytes, 0);
  assert(s.length === 2, 'two samples: ' + JSON.stringify(s));
  assert(s[0].dts === 9000 && s[1].dts === 9512 && s[0].key && !s[1].key, 'times and key flags: ' + JSON.stringify(s));
  assert(s[0].offset === moofLen + 8 && s[0].size === 3 && s[1].offset === moofLen + 11 && s[1].size === 4, 'sample byte ranges: ' + JSON.stringify(s));
});

Deno.test('feature maths: FFT of a sine peaks at its bin; audio frames report loudness', () => {
  const N = 1024, re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.sin(2 * Math.PI * 64 * i / N);
  BAS.avFeatures.fft(re, im);
  let best = 1;
  for (let k = 1; k < N / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
  assert(best === 64, 'peak at bin 64, got ' + best);
  const rate = 16000, pcm = new Float32Array(rate * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i < rate ? 0.5 : 0.05) * Math.sin(2 * Math.PI * 440 * i / rate);
  const fr = BAS.avFeatures.audioFrames(pcm, rate, 10);
  assert(fr.length >= 6 && fr[0].t > 10, 'frames timed from t0');
  const loud = fr.find((f) => f.t < 10.7), quiet = fr.find((f) => f.t > 11.3);
  assert(loud.db - quiet.db > 15, 'loud vs quiet: ' + loud.db + ' / ' + quiet.db);
  assert(Math.abs(loud.centroid - 440) < 120, 'centroid near 440 Hz: ' + loud.centroid);
});

// ---- measured data (private; frame-verified ads, see test/fixtures/expected.json)
Deno.test({ name: 'measured: every ad is confirmed with boundaries ±5 s off, and its end snaps within 2.5 s', ignore: !HAS_AV }, () => {
  const exp = loadExpected();
  for (const [bv, segs] of Object.entries(exp.segments)) {
    const d = loadAvFixture(bv + '_ad');
    const { start, end } = segs[0];
    for (const [ds, de] of [[0, 0], [-4, 5], [4, -5], [2, 6], [-2, -6]]) {
      const r = AV.assess(d, start + ds, end + de);
      assert(r.verdict === 'ad', `${bv} ${ds}/${de}: ` + JSON.stringify(r));
      assert(Math.abs(r.end - end) <= 2.5, `${bv} ${ds}/${de} end ${r.end} vs ${end}`);
      // a start only moves a little (segues hide the cut): never more than 0.5 s earlier than the estimate
      assert(r.start >= start + ds - 0.5 && r.start <= start + ds + 3, `${bv} ${ds}/${de} start ${r.start} vs estimate ${start + ds}`);
      if (ds >= -2) assert(r.start >= start - 2.5, `${bv} ${ds}/${de} start ${r.start} cuts content (${start})`);
    }
  }
});

Deno.test({ name: 'measured: skip-here presses anywhere inside an ad land within 2.5 s of its end', ignore: !HAS_AV }, () => {
  const exp = loadExpected();
  for (const [bv, segs] of Object.entries(exp.segments)) {
    const d = loadAvFixture(bv + '_ad');
    const { start, end } = segs[0];
    for (const t of [start + 8, start + 30, (start + end) / 2, end - 25, end - 10]) {
      const f = AV.findEnd(d, t);
      assert(f && !f.pending && Math.abs(f.t - end) <= 2.5, `${bv} press ${t.toFixed(0)}: ` + JSON.stringify(f));
    }
  }
});

Deno.test({ name: 'measured: story/benchmark skips, intros and ordinary content are never confirmed as ads', ignore: !HAS_AV }, () => {
  const named = [['BV1xdNt6TEP3_skip', 1195, 1416], ['BV1fHaB6WEh1_skip', 748, 779], ['BV17uhW6VE2R_intro', 0, 290], ['BV1eZ4y1j7kw_intro', 0, 120], ['BV1hGaG6vEX2_intro', 34, 240]];
  for (const [f, s, e] of named) {
    const r = AV.assess(loadAvFixture(f), s, e);
    assert(r.verdict !== 'ad', `${f}: ` + JSON.stringify(r));
  }
  assert(AV.assess(loadAvFixture('BV1xdNt6TEP3_skip'), 1195, 1416).verdict === 'notAd', 'the story skip is refuted');
  let n = 0, conf = 0;
  for (const f of ['BV1jCJs6UE9S', 'BV11NV86tEjW', 'BV1VV5T6mEXM', 'BV1Ebho6BE2J', 'BV1A2bi6UEev', 'BV1T7411W7ca', 'BV1oZeA6fERD']) {
    const d = loadAvFixture(f + '_content');
    for (let len = 60; len <= 130; len += 10) for (let s = d.t0 + 25; s + len <= d.t1 - 25; s += 5) {
      const r = AV.assess(d, s, s + len);
      if (r.verdict === 'unknown') continue;
      n++; if (r.verdict === 'ad') conf++;
    }
  }
  assert(n > 100, 'enough slices: ' + n);
  assert(conf === 0, `content slices confirmed as ads: ${conf}/${n}`);
});

Deno.test('open-ended danmaku start: A/V supplies the end only when the span looks like an ad', () => {
  const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
  const d = synth();
  const r = AV.assessOpen(d, 103);
  assert(r.verdict === 'ad' && Math.abs(r.end - 200) <= 0.5 && r.endBy === 'av', 'end found: ' + JSON.stringify(r));
  const open = { source: 'danmaku', start: 103, end: null, confidence: 0.45, reason: 'r', evidence: { adVocab: 2 } };
  assert(AV.wants(open) && AV.key(open) === 'danmaku:103-open', 'open candidates are probed under their own key');
  const [c] = AV.apply([open], new Map([[AV.key(open), r]]), S);
  assert(c.end === r.end && c.lockEnd && c.confidence >= S.minConfidence && c.sources.includes('media'), 'closed and auto: ' + JSON.stringify(c));
  const weak = AV.apply([Object.assign({}, open, { evidence: {} })], new Map([[AV.key(open), r]]), S)[0];
  assert(weak.end === r.end && weak.confidence === 0.45, 'without start evidence the end is filled but not boosted');
  const plain = AV.assessOpen(synth({ adLike: false }), 103);
  assert(plain.verdict !== 'ad', 'plain content: ' + JSON.stringify(plain));
  const kept = AV.apply([open], new Map([[AV.key(open), plain]]), S)[0];
  assert(kept === open || kept.end == null, 'stays open-ended when the media does not confirm');
});

Deno.test({ name: 'measured: open-ended starts get the right end; content never yields one', ignore: !HAS_AV }, () => {
  const exp = loadExpected();
  for (const [bv, segs] of Object.entries(exp.segments)) {
    const { start, end } = segs[0];
    for (const off of [0, 3, 7]) {
      const r = AV.assessOpen(loadAvFixture(bv + '_ad'), start + off);
      assert(r.verdict === 'ad' && Math.abs(r.end - end) <= 2.5, `${bv} +${off}: ` + JSON.stringify(r));
    }
  }
  let n = 0;
  for (const f of ['BV1jCJs6UE9S_content', 'BV11NV86tEjW_content', 'BV1VV5T6mEXM_content', 'BV1Ebho6BE2J_content', 'BV1A2bi6UEev_content', 'BV1T7411W7ca_content', 'BV1oZeA6fERD_content', 'BV1xdNt6TEP3_skip', 'BV17uhW6VE2R_intro', 'BV1hGaG6vEX2_intro']) {
    const d = loadAvFixture(f);
    for (let s = d.t0 + 20; s < d.t1 - 60; s += 10) {
      const r = AV.assessOpen(d, s);
      n++;
      assert(r.verdict !== 'ad', `${f} @${s}: ` + JSON.stringify(r));
    }
  }
  assert(n > 100, 'enough starts: ' + n);
});
