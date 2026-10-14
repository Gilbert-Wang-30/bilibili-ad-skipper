// Human-readable report of BAS.detectDanmaku over every full fixture.
// Run:  deno run --allow-read test/report-danmaku.js [bvid ...] [--verbose]
import { loadBAS, loadFullFixture, toDanmaku, loadExpected, listFixtures, hasFullFixtures } from './load.js';
if (!hasFullFixtures()) { console.log('test/fixtures-full/ (real-danmaku corpus) is not present; it is not distributed. Nothing to report.'); Deno.exit(0); }

let BAS;
try { BAS = loadBAS(); } catch (e) { BAS = loadBAS(['00-ns.js', '31-detect-danmaku.js']); }
const { fmtTime } = BAS.util;

const args = Deno.args.filter((a) => !a.startsWith('--'));
const verbose = Deno.args.includes('--verbose');
const expected = loadExpected();
const bvids = args.length ? args : listFixtures(true);

const label = (bvid) => {
  if (expected.segments[bvid]) return 'AD';
  if (expected.negatives.includes(bvid)) return 'NEG';
  if (expected.unknown.includes(bvid)) return '???';
  return '';
};
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

let totalMs = 0, totalItems = 0;
for (const bvid of bvids) {
  const fx = loadFullFixture(bvid);
  const dm = toDanmaku(fx.dm);
  const t0 = performance.now();
  const res = BAS.detectDanmaku(dm, fx.duration, BAS.DEFAULT_SETTINGS);
  const ms = performance.now() - t0;
  totalMs += ms; totalItems += dm.length;
  const exp = expected.segments[bvid] ? expected.segments[bvid].map((s) => `${fmtTime(s.start)}-${fmtTime(s.end)}`).join(',') : '';
  const offers = (expected.offers[bvid] || []).map((s) => `${fmtTime(s.start)}-${s.end != null ? fmtTime(s.end) : fmtTime(s.endMin) + '..' + fmtTime(s.endMax)}`).join(',');
  console.log(`\n${pad(bvid, 13)} ${pad(label(bvid), 4)} ${pad(fmtTime(fx.duration), 8)} n=${pad(dm.length, 6)} ${ms.toFixed(1).padStart(6)}ms  ${fx.title.slice(0, 44)}${exp ? '  [expected ' + exp + ']' : ''}${offers ? '  [offer ' + offers + ']' : ''}`);
  if (!res.candidates.length) console.log('    (no candidates)');
  for (const c of res.candidates) {
    const flag = c.confidence >= 0.6 && !c.offerOnly ? 'AUTO ' : c.offerOnly ? 'offer' : 'low  ';
    const e = c.evidence || {};
    console.log(`    ${flag} ${pad(fmtTime(c.start), 7)} - ${pad(c.end == null ? '?' : fmtTime(c.end), 7)} conf=${c.confidence.toFixed(2)}  ${c.reason}  [agree=${e.targetsAgree} vocab=${e.adVocab} strong=${e.strongEnd} med=${e.mediumEnd} src=${e.endSource} w=${e.clusterWeight}${e.divergent ? ' divergent' : ''}]`);
    if (verbose) {
      const show = (name, arr) => { if (arr && arr.length) console.log(`        ${name}: ` + arr.slice(0, 8).map((x) => `${x.t.toFixed(0)}s "${x.text}"${x.target != null ? '→' + fmtTime(x.target) : ''}`).join(' | ')); };
      show('start', e.startItems); show('targets', e.targets); show('thanks', e.thanks);
    }
  }
  if (verbose && res.diagnostics.clusters.length) {
    console.log('    clusters: ' + res.diagnostics.clusters.map((c) => `${fmtTime(c.first)}..${fmtTime(c.last)} w=${c.weight} n=${c.items} tg=${c.targets} ${c.status}`).join(' ; '));
  }
  if (res.diagnostics.chatty) console.log('    (chatty video penalty applied)');
}
console.log(`\nTotal ${bvids.length} videos, ${totalItems} danmaku, ${totalMs.toFixed(0)} ms (${(totalMs / bvids.length).toFixed(1)} ms/video)`);
