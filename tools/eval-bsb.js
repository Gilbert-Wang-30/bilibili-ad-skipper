// Offline accuracy check against the crowd labels of BilibiliSponsorBlock (https://github.com/hanydd/BilibiliSponsorBlock,
// public dump https://download.bsbsb.top/database.zip). Uses private local data only; nothing here is published:
//   test/fixtures-full/bsb/labels.json      segments from the dump (times, category, votes; no user ids)
//   test/fixtures-full/bsb/selection.json   {positives: [BV…], controls: [BV…]}
//   test/fixtures-full/bsb/videos/BV….json  inputs as the extension sees them (danmaku, heat curve, chapters), collected
//                                           anonymously through the API in the scratch browser (tools/cdp.js)
//   test/fixtures-full/bsb/av/BV….json      optional A/V look-ahead features per probe window (numbers only)
// Usage: deno run --allow-read [--allow-write] tools/eval-bsb.js [--details=out.json] [--wanted=out.json]
import { loadBAS, toDanmaku } from '../test/load.js';

const BAS = loadBAS();
const ROOT = new URL('../test/fixtures-full/bsb/', import.meta.url);
const args = Object.fromEntries(Deno.args.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const readJSON = (rel) => JSON.parse(Deno.readTextFileSync(new URL(rel, ROOT)));
const exists = (rel) => { try { Deno.statSync(new URL(rel, ROOT)); return true; } catch (_) { return false; } };

const labels = readJSON('labels.json');
const selection = readJSON('selection.json');
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const iou = (a, b) => { const o = overlap(a.start, a.end, b.start, b.end); return o / Math.max(1e-9, (a.end - a.start) + (b.end - b.start) - o); };
const q = (xs, p) => { if (!xs.length) return NaN; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => (isFinite(x) ? Math.round(x * 10) / 10 : x);

/** Crowd truth for one video: well-voted sponsor skips (overlapping submissions merged, the best-voted one kept). */
function truthOf(bv, cid, duration) {
  // labels of an earlier file of the same part (re-upload, same length ±2 s) count too
  const segs = (labels[bv] || []).filter((s) => !s.cid || String(s.cid) === String(cid) || (s.dur > 0 && Math.abs(s.dur - duration) <= 2));
  const good = segs.filter((s) => s.cat === 'sponsor' && s.act === 'skip' && !s.hidden && (s.votes >= 1 || s.locked) && s.e - s.s >= 15 && s.e - s.s <= 400)
    .sort((a, b) => (b.locked - a.locked) || (b.votes - a.votes));
  const truth = [];
  for (const s of good) if (!truth.some((t) => overlap(t.start, t.end, s.s, s.e) > 0.3 * Math.min(t.end - t.start, s.e - s.s))) truth.push({ start: s.s, end: s.e, votes: s.votes, locked: s.locked });
  // anything people marked (any category, not hidden): an auto-skip overlapping it is at least plausible
  const any = segs.filter((s) => !s.hidden && s.act !== 'full' && s.e > s.s).map((s) => ({ start: s.s, end: s.e, cat: s.cat }));
  return { truth, any };
}

/** Detectors + the extension's own pipeline (38-pipeline.js) on the collected inputs. */
function run(d, settings, av) {
  const S = Object.assign({}, BAS.DEFAULT_SETTINGS, settings);
  const ch = BAS.detectChapters(d.view_points || [], d.duration, S);
  const dm = BAS.detectDanmaku(toDanmaku(d.dm || []), d.duration, S);
  const heatAnalysis = d.heat && S.useHeat !== false ? BAS.detectHeat.analyse(d.heat, d.duration) : null;
  return BAS.buildSegments({ candidates: [].concat(ch.candidates || [], dm.candidates || []), duration: d.duration, boundaries: ch.boundaries || [], heatAnalysis, av, settings: S });
}

/** A/V verdicts from stored probe features, judged exactly as the orchestrator does. */
function avResults(bv, wanted, heatStep) {
  const m = new Map();
  if (!exists(`av/${bv}.json`)) return m;
  const store = readJSON(`av/${bv}.json`);
  for (const c of wanted) {
    const k = BAS.avSegment.key(c), w = store[k];
    if (!w || (!w.audio.length && w.errors && w.errors.length)) continue;
    const data = { audio: w.audio.map((r) => ({ t: r[0], db: r[1], flux: r[2] / 1000 })), video: w.video.map((r) => ({ t: r[0], mean: r[1], cut: r[2], drift: r[3] })) };
    const r = BAS.avSegment.isOpen(c) ? BAS.avSegment.assessOpen(data, c.start)
      : BAS.avSegment.assess(data, c.start, c.end, { endRadius: c.source === 'heat' ? Math.max(8, Math.min(30, heatStep || 8)) : undefined });
    m.set(k, { verdict: r.verdict, score: r.score, z: r.z, start: r.start, end: r.end, startBy: r.startBy, endBy: r.endBy });
  }
  return m;
}

const MODES = [
  { name: 'danmaku', settings: { useHeat: false, useAvProbe: false } },
  { name: '+heat', settings: { useAvProbe: false } },
  { name: '+heat+A/V', settings: { useAvProbe: true }, av: true },
];
const stats = {};
for (const m of MODES) stats[m.name] = { miss: {}, truth: 0, autoHit: 0, anyHit: 0, startErr: [], endErr: [], cut: [], autoSegs: 0, unexplained: 0, ctlVideos: 0, ctlAuto: 0, ctlAutoVideos: 0, videos: 0 };
const details = [];
const cov = { positives: { targets: 0, covered: 0, windows: 0, ad: 0 }, controls: { targets: 0, covered: 0, windows: 0, ad: 0 } };
const changes = [];
const avFailed = (bv, wanted) => {
  if (!exists(`av/${bv}.json`)) return 0;
  const store = readJSON(`av/${bv}.json`);
  return wanted.filter((c) => { const w = store[BAS.avSegment.key(c)]; return w && !w.audio.length && w.errors && w.errors.length; }).length;
};
const wantedOut = {};
let used = 0, skipped = 0, avVideos = 0;
const AV_MAX = 4;

for (const group of ['positives', 'controls']) {
  for (const bv of selection[group]) {
    if (!exists(`videos/${bv}.json`)) { skipped++; continue; }
    const d = readJSON(`videos/${bv}.json`);
    const sameLength = (labels[bv] || []).some((s) => s.dur > 0 && Math.abs(s.dur - d.duration) <= 2);
    if ((!d.cidMatched && !sameLength) || !(d.duration > 0)) { skipped++; continue; }
    used++;
    const { truth, any } = truthOf(bv, d.cid, d.duration);
    const step = d.heat && d.heat.step;
    // probe targets as the orchestrator would pick them (auto-skip candidates first, then offers; earliest first; ≤ 4)
    const base = run(d, MODES[1].settings, null);
    const wanted = base.avWanted.slice().sort((a, b) => (!!a.offerOnly - !!b.offerOnly) || a.start - b.start)
      .filter((c) => { const end = BAS.avSegment.isOpen(c) ? c.start + BAS.avSegment.CONST.OPEN_SPAN : c.end; return end - c.start <= 420; }).slice(0, AV_MAX);
    if (wanted.length) wantedOut[bv] = { cid: d.cid, duration: d.duration, windows: wanted.map((c) => ({ key: BAS.avSegment.key(c), start: c.start, end: c.end, open: BAS.avSegment.isOpen(c) })) };
    const av = avResults(bv, wanted, step);
    if (av.size) avVideos++;
    const covered = wanted.length > 0 && av.size + avFailed(bv, wanted) >= wanted.length;
    cov[group].targets += wanted.length ? 1 : 0; cov[group].covered += covered ? 1 : 0;
    for (const [k, r] of av) { cov[group].windows++; if (r.verdict === 'ad') cov[group].ad++; }
    const row = { bv, group, duration: d.duration, danmaku: d.dm.length, heat: !!d.heat, truth: truth.map((t) => [r1(t.start), r1(t.end)]), modes: {} };
    for (const m of MODES) {
      const r = m.av ? run(d, m.settings, av) : (m.name === '+heat' ? base : run(d, m.settings, null));
      const autos = r.segments.filter((s) => s.autoSkip && s.enabled !== false);
      const st = stats[m.name];
      st.videos++;
      const res = { auto: autos.map((s) => [r1(s.start), r1(s.end), s.confidence, (s.sources || []).join('+')]), offers: r.segments.filter((s) => !s.autoSkip).map((s) => [r1(s.start), r1(s.end)]) };
      if (group === 'positives') {
        for (const t of truth) {
          st.truth++;
          const a = autos.filter((s) => iou(s, t) >= 0.4).sort((x, y) => iou(y, t) - iou(x, t))[0];
          if (r.segments.some((s) => iou(s, t) >= 0.4)) st.anyHit++;
          if (!a) {
            // why it was missed: the best thing the pipeline had for it
            const near = (xs) => xs.some((s) => s.end != null && isFinite(s.end) ? iou(s, t) >= 0.4 : (s.start >= t.start - 30 && s.start <= t.end - 10));
            const why = autos.some((s) => overlap(s.start, s.end, t.start, t.end) > 0) ? 'auto, boundaries off'
              : near(r.segments.filter((s) => !s.autoSkip)) ? 'offer only'
              : near(r.dropped.filter((s) => s.source === 'danmaku' && (s.end == null || !isFinite(s.end)))) ? 'danmaku start, no end'
              : near(r.dropped) ? 'dropped' : r.segments.some((s) => overlap(s.start, s.end, t.start, t.end) > 0) ? 'offer, boundaries off' : 'no signal';
            st.miss[why] = (st.miss[why] || 0) + 1;
            (res.missed = res.missed || []).push([r1(t.start), r1(t.end), why]);
            continue;
          }
          st.autoHit++;
          st.startErr.push(a.start - t.start); st.endErr.push(a.end - t.end);
          // content cut beyond 3 s of label noise: starting too early or ending too late
          st.cut.push(Math.max(0, t.start - a.start - 3) + Math.max(0, a.end - t.end - 3));
        }
        for (const a of autos) {
          st.autoSegs++;
          const explained = any.some((x) => overlap(a.start, a.end, x.start, x.end) >= 0.3 * (a.end - a.start));
          if (!explained) { st.unexplained++; (res.unexplained = res.unexplained || []).push([r1(a.start), r1(a.end)]); }
        }
      } else {
        st.ctlVideos++; st.ctlAuto += autos.length; if (autos.length) st.ctlAutoVideos++;
      }
      row.modes[m.name] = res;
      if (m.av) {
        // auto-skips the A/V step added or removed, with their evidence
        const before = run(d, MODES[1].settings, null).segments.filter((x) => x.autoSkip);
        const key = (x) => Math.round(x.start / 5) + ':' + Math.round(x.end / 5);
        const bk = new Set(before.map(key)), ak = new Set(autos.map(key));
        const isHit = (x) => truth.some((t) => iou(x, t) >= 0.4);
        const anyLab = (x) => any.some((y) => overlap(x.start, x.end, y.start, y.end) >= 0.3 * (x.end - x.start));
        const evOf = (x) => { const e = x.evidence || {}; return { targetsAgree: e.targetsAgree, adVocab: e.adVocab, strongEnd: e.strongEnd, av: e.av && { v: e.av.verdict, s: e.av.score }, heat: !!e.heat, endZone: !!e.endZone }; };
        for (const x of autos) if (!bk.has(key(x))) changes.push({ bv, group, kind: 'gained', start: r1(x.start), end: r1(x.end), conf: x.confidence, hit: isHit(x), labelled: anyLab(x), cats: any.filter((y) => overlap(x.start, x.end, y.start, y.end) >= 0.3 * (x.end - x.start)).map((y) => y.cat), ev: evOf(x), dur: d.duration });
        for (const x of before) if (!ak.has(key(x))) changes.push({ bv, group, kind: 'lost', start: r1(x.start), end: r1(x.end), hit: isHit(x), dur: d.duration });
      }
    }
    details.push(row);
  }
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
console.log(`videos used ${used} (skipped ${skipped}: not collected / other part); A/V results for ${avVideos}`);
console.log(['mode', 'recall auto', 'recall any', 'start err p50/p90 |abs|', 'end err p50/p90 |abs|', 'cut>3s', 'unlabeled auto', 'controls w/ auto'].join(' | '));
for (const m of MODES) {
  const st = stats[m.name];
  const abs = (xs) => xs.map(Math.abs);
  console.log([
    m.name.padEnd(10),
    `${st.autoHit}/${st.truth} ${pct(st.autoHit, st.truth)}`,
    `${st.anyHit}/${st.truth} ${pct(st.anyHit, st.truth)}`,
    `${r1(q(abs(st.startErr), 0.5))}/${r1(q(abs(st.startErr), 0.9))} s (signed p50 ${r1(q(st.startErr, 0.5))})`,
    `${r1(q(abs(st.endErr), 0.5))}/${r1(q(abs(st.endErr), 0.9))} s (signed p50 ${r1(q(st.endErr, 0.5))})`,
    `${st.cut.filter((x) => x > 0).length}/${st.cut.length}`,
    `${st.unexplained}/${st.autoSegs}`,
    `${st.ctlAutoVideos}/${st.ctlVideos} (${st.ctlAuto} segs)`,
  ].join(' | '));
}
for (const m of MODES) console.log('misses', m.name.padEnd(10), JSON.stringify(stats[m.name].miss));
for (const g of ['positives', 'controls']) console.log(`A/V coverage ${g}: ${cov[g].covered}/${cov[g].targets} videos with probe targets fully probed; ${cov[g].windows} windows judged, ${cov[g].ad} 'ad'`);
const gained = changes.filter((c) => c.kind === 'gained'), lost = changes.filter((c) => c.kind === 'lost');
console.log(`A/V changes: gained ${gained.length} auto-skips (${gained.filter((c) => c.hit).length} true hits, ${gained.filter((c) => !c.hit && c.labelled).length} on other labels, ${gained.filter((c) => !c.hit && !c.labelled).length} unlabeled); lost ${lost.length} (${lost.filter((c) => c.hit).length} true hits)`);
if (args.changes) Deno.writeTextFileSync(args.changes, JSON.stringify(changes, null, 1));
if (args.details) Deno.writeTextFileSync(args.details, JSON.stringify(details, null, 1));
if (args.wanted) Deno.writeTextFileSync(args.wanted, JSON.stringify(wantedOut, null, 1));
