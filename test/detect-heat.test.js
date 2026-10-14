// Tests for src/content/34-detect-heat.js against the real 高能进度条 curves of the fixture videos (test/fixtures/pbp.json).
import { assert, assertEquals } from './assert.js';
import { loadBAS, listFixtures, loadFullFixture, toDanmaku, loadExpected, hasFullFixtures } from './load.js';
// The real-danmaku corpus (test/fixtures-full/) is third-party user content and is not distributed; see README.
const HAS_CORPUS = hasFullFixtures();

const BAS = loadBAS();
const H = BAS.detectHeat;
const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
const exp = loadExpected();
const pbp = JSON.parse(Deno.readTextFileSync(new URL('./fixtures/pbp.json', import.meta.url)));
const truth = exp.segments, neg = new Set(exp.negatives);
const heatOf = (bv, dur) => (pbp[bv] && pbp[bv].v && pbp[bv].v.length ? H.analyse({ step: pbp[bv].s, values: pbp[bv].v, events: pbp[bv].ev }, dur) : null);
const auto = (c) => c.filter((x) => x.confidence >= 0.6 && !x.offerOnly);
const near = (c, t, tol = 15) => Math.abs(c.start - t.start) <= tol && Math.abs(c.end - t.end) <= tol;

Deno.test('heat: parses the current (modules) and the old endpoint format', () => {
  const data = { step_sec: 5, events: { default: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }, debug: '{"event_count":123456}' };
  const a = H.parse({ modules: [{ name: 'pbp', params: { data } }] });
  const b = H.parse(data);
  assertEquals(a, { step: 5, values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], events: 123456 });
  assertEquals(b, a);
  assertEquals(H.parse(null), null);
  assertEquals(H.parse({ modules: [] }), null);
  assertEquals(H.analyse({ step: 5, values: [1, 2, 3], events: 1e6 }, 100).usable, false);
  assertEquals(H.analyse({ step: 5, values: new Array(50).fill(100), events: 100 }, 250).usable, false, 'too few viewer events');
});

Deno.test({ name: 'heat: every measured ad has an ad-shaped run whose peak brackets the real end', ignore: !HAS_CORPUS }, () => {
  let n = 0;
  for (const [bv, [t]] of Object.entries(truth)) {
    const fx = loadFullFixture(bv);
    const a = heatOf(bv, fx.duration);
    if (!a || !a.usable) continue;            // the two newest videos have no curve yet
    n++;
    const r = H.matchRun(a, t.start, t.end);
    assert(r, `${bv}: no ad-shaped run brackets ${t.start}-${t.end}: ` + JSON.stringify(a.runs.filter((x) => x.n >= 2)));
  }
  assert(n >= 6, 'at least 6 measured ads have heat data, got ' + n);
});

Deno.test({ name: 'heat: full density — confirms the real ads and creates no auto-skip on ad-free videos', ignore: !HAS_CORPUS }, () => {
  for (const bv of listFixtures(true)) {
    const fx = loadFullFixture(bv);
    const a = heatOf(bv, fx.duration);
    if (!a) continue;
    const base = BAS.detectDanmaku(toDanmaku(fx.dm), fx.duration, S).candidates;
    const out = H.corroborate(base, a, S).concat(H.offers(base, a, S));
    if (truth[bv]) {
      const hit = auto(out).find((c) => near(c, truth[bv][0], 4));
      assert(hit, `${bv}: real ad still auto-skipped within 4 s`);
      assert(/热度佐证/.test(hit.reason), `${bv}: ad confirmed by heat: ${hit.reason}`);
    }
    if (neg.has(bv)) assert(auto(out).length === 0, `${bv}: no auto-skip on an ad-free video: ` + JSON.stringify(auto(out).map((c) => [c.start, c.end, c.confidence, c.reason])));
  }
});

Deno.test({ name: 'heat: with signed-out-like danmaku (1/10) every measured ad becomes auto, still no false skips', ignore: !HAS_CORPUS }, () => {
  for (const seed of [0, 1, 2]) {
    for (const bv of listFixtures(true)) {
      const fx = loadFullFixture(bv);
      const a = heatOf(bv, fx.duration);
      if (!a || !a.usable) continue;
      const rows = fx.dm.filter((_, i) => (i + seed) % 10 === 0);
      const out = H.corroborate(BAS.detectDanmaku(toDanmaku(rows), fx.duration, S).candidates, a, S);
      if (truth[bv]) assert(auto(out).some((c) => near(c, truth[bv][0])), `${bv} seed ${seed}: ad auto-skipped with heat`);
      if (neg.has(bv)) assert(auto(out).length === 0, `${bv} seed ${seed}: no false auto-skip`);
    }
  }
});

Deno.test({ name: 'heat: guard caps a coordinate-less auto candidate on a popular video whose curve shows no skipping', ignore: !HAS_CORPUS }, () => {
  const fx = loadFullFixture('BV1bQh463EU6');                       // verified ad-free
  const rows = fx.dm.filter((_, i) => i % 4 === 0);
  const base = BAS.detectDanmaku(toDanmaku(rows), fx.duration, S).candidates;
  assert(auto(base).length >= 1, 'precondition: danmaku alone produce a false auto candidate at 1/4 density');
  const out = H.corroborate(base, heatOf('BV1bQh463EU6', fx.duration), S);
  assert(auto(out).length === 0, 'the heat guard removes it');
  assert(out.some((c) => /热度未见跳过/.test(c.reason)), 'the reason says why');
});

Deno.test({ name: 'heat: offers only on real ads, never auto, and not on jump-to-highlight spikes', ignore: !HAS_CORPUS }, () => {
  for (const bv of listFixtures(true)) {
    const fx = loadFullFixture(bv);
    const a = heatOf(bv, fx.duration);
    if (!a) continue;
    for (const o of H.offers([], a, S)) {
      assert(o.offerOnly && o.confidence < 0.6 && o.source === 'heat', 'offers are manual only');
      assert(truth[bv] && o.start < truth[bv][0].end && o.end > truth[bv][0].start, `${bv}: offer ${o.start}-${o.end} lies on a real ad`);
    }
  }
  const spike = heatOf('BV11NV86tEjW', 2409).runs.find((r) => r.start >= 2000 && r.start <= 2150 && r.n >= 3);
  assert(spike && !spike.adLike && !spike.offer, 'the 35-minute highlight spike is not ad-shaped');
});

Deno.test({ name: 'heat: useHeat=false disables confirmation, guard and offers', ignore: !HAS_CORPUS }, () => {
  const fx = loadFullFixture('BV1jCJs6UE9S');
  const a = heatOf('BV1jCJs6UE9S', fx.duration);
  const off = Object.assign({}, S, { useHeat: false });
  const base = [{ start: 250, end: 360, source: 'danmaku', confidence: 0.5, reason: 'x', evidence: { targetsAgree: 1 } }];
  assertEquals(H.corroborate(base, a, off), base);
  assertEquals(H.offers([], a, off), []);
  assert(H.corroborate(base, a, S)[0].confidence === 0.7, 'enabled: +0.2');
});
