// Tests for src/content/28-detect-subtitles.js + 27-subtitle-model.js (sponsor reads in the AI subtitles, scored with the
// local phrase table) and their use by the skip button / fusion.
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const D = BAS.detectSubtitles;
// The collected transcripts (test/fixtures-full/bsb/subs/) are third-party content and are not distributed; see README.
const CORPUS = new URL('./fixtures-full/bsb/', import.meta.url);
const HAS_CORPUS = (() => { try { Deno.statSync(new URL('subs/subs1.json', CORPUS)); return true; } catch (_) { return false; } })();

/** lines: [[from, text], ...] → subtitle body with 2 s lines */
const body = (rows) => rows.map(([from, content]) => ({ from, to: from + 2, content }));
// ordinary narration (a history story) around the read
const TOPIC = ['这一年他回到了老家', '村里的人都很惊讶', '那时候的条件很差', '他每天天不亮就出门', '后来的事情大家都知道了', '这件事一直被人提起', '我们接着往下看', '当时的报纸是这样写的'];
const filler = (from, to) => { const r = []; for (let t = from, i = 0; t < to; t += 3, i++) r.push([t, TOPIC[i % TOPIC.length]]); return r; };

// a typical read: a segue, the product named a few times, then the calls to action
const READ = [
  [300, '说到熬夜剪视频'], [303, '我最近一直在用小象家的电动牙刷'], [306, '小象家电动牙刷有三种清洁模式'], [309, '刷完牙齿特别干净'],
  [312, '续航也很长充一次能用两个月'], [315, '小象家这款现在活动价只要两百多'], [318, '评论区置顶链接就能领券下单'], [321, '还有保价和运费险'],
];
const VIDEO = body([].concat(filler(0, 298), READ, filler(324, 900)));
// the read's edges: its segue (300) and the end of its last call to action (323), each within one 3 s line — the
// accuracy the detector is measured by (an edge within 3 s of the crowd's mark)
const atStart = (t) => t >= 297 && t <= 300, atEnd = (t) => t >= 323 && t <= 326;

Deno.test('detectSubtitles: a read is found from its segue to its last call to action', () => {
  const r = D(VIDEO, 900);
  assertEquals(r.candidates.length, 1);
  const c = r.candidates[0];
  assertEquals(c.source, 'subtitle');
  assert(atStart(c.start) && atEnd(c.end), JSON.stringify([c.start, c.end]));
  assert(c.confidence >= 0.75, 'calls to action, a product named three times: ' + c.confidence);
  assert(!c.offerOnly);
  assert(/口播/.test(c.reason) && c.evidence.subtitle.p >= 0.9, c.reason);
});

Deno.test('detectSubtitles: a passing mention, a product review and a sale guide without calls to action are not reads', () => {
  const passing = body([].concat(filler(0, 200), [[200, '工具的链接我放在简介里了']], filler(203, 600)));
  assertEquals(D(passing, 600).candidates.length, 0);
  const review = body([].concat(filler(0, 100), [[100, '这款手机的屏幕是2K分辨率'], [103, '价格是四千九'], [106, '续航表现不错'], [109, '性价比很高推荐']], filler(112, 600)));
  assertEquals(D(review, 600).candidates.length, 0);
});

Deno.test('detectSubtitles: a video that sells from start to end is never auto-skipped', () => {
  // the read above, k times, 200 s apart: four reads are four ads; a fifth makes it a shopping video (> maxReads)
  const video = (k) => {
    const rows = []; let t = 0;
    for (let r = 0; r < k; r++) { const t0 = 100 + r * 200; rows.push(...filler(t, t0 - 2), ...READ.map(([d, x]) => [d - 300 + t0, x])); t = t0 + 24; }
    return body(rows.concat(filler(t, 1200)));
  };
  const four = D(video(4), 1200).candidates;
  assertEquals(four.length, 4);
  assert(four.every((c) => !c.offerOnly && c.confidence >= 0.75), JSON.stringify(four.map((c) => [c.start, c.offerOnly, c.confidence])));
  const five = D(video(5), 1200).candidates;
  assertEquals(five.length, 5);
  assert(five.every((c) => c.offerOnly && c.confidence <= 0.5 && /整期像带货/.test(c.reason)), JSON.stringify(five.map((c) => [c.start, c.offerOnly, c.confidence])));
  // one read that is over 40 % of a short video: also only offered
  const short = D(body([].concat(filler(0, 18), READ.map(([t, x]) => [t - 280, x]), filler(44, 46))), 46).candidates;
  assertEquals(short.length, 1);
  assert(short[0].offerOnly && /整期像带货/.test(short[0].reason), JSON.stringify(short));
});

Deno.test('detectSubtitles: English transcripts are not guessed at (the table is Chinese); malformed input', () => {
  const en = body([].concat(filler(0, 100).map(([t]) => [t, 'and then we went back to the lab']), [[100, 'This video is sponsored by Brand.'], [103, 'Use my code for a discount.'], [106, 'The link is in the description below.'], [109, 'Check it out.']], filler(112, 400).map(([t]) => [t, 'so the next step was soldering'])));
  assertEquals(D(en, 400).candidates.filter((c) => !c.offerOnly), []);
  assertEquals(D(null, 100).candidates, []);
  assertEquals(D([{ from: 'x' }, null, { from: 5, to: 2, content: '链接' }], 100).candidates, []);
});

Deno.test('readEndAt: the end of the read playing now; nothing outside a read', () => {
  const L = D.prepare(VIDEO, 900);
  const r = D.readEndAt(L, 310, 900);
  assert(atEnd(r.end) && r.detected, JSON.stringify(r));
  assertEquals(D.readEndAt(L, 600, 900), null);
  // a press reuses the detection, but not across a different model or duration
  const M = BAS.subtitleModel;
  try {
    BAS.subtitleModel = Object.assign({}, M, { params: Object.assign({}, M.params, { auto: 1.01 }) });
    const offered = D.readEndAt(L, 310, 900);
    assert(offered && atEnd(offered.end) && offered.detected === false, JSON.stringify(offered));
  } finally { BAS.subtitleModel = M; }
  assert(D.readEndAt(L, 310, 900).detected);
  assertEquals(D.readEndAt(L, 310, 315).end, 315);   // a shorter video: the read is cut at its end
});

Deno.test('detectSubtitles: work per line is bounded on files that are not sentence-timed speech', () => {
  // 200 lines in one second, each its own 2-gram: a line's context is at most 24 neighbours per side
  const CH = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥金木水火土日月星山川';
  const dense = Array.from({ length: 200 }, (_, i) => ({ from: 100 + i / 200, to: 100.2 + i / 200, content: CH[i % CH.length] + CH[(i * 7 + 3) % CH.length] }));
  const L = D.prepare(dense, 300);
  const before = D.features(L, 199).filter((f) => f.startsWith('b:')).length;
  assert(before > 0 && before <= D.CONST.MAX_NEAR, String(before));
  // a very long line is scored on its first MAX_CHARS characters
  const long = D.prepare([{ from: 0, to: 5, content: '好'.repeat(500) }], 10);
  assertEquals(long[0].n.length, D.CONST.MAX_CHARS);
  // the same line said 20 000 times in 150 s: prepare stays fast (it was quadratic)
  const t0 = performance.now();
  D.prepare(Array.from({ length: 20000 }, (_, i) => ({ from: i * 0.0075, to: i * 0.0075 + 0.005, content: '欢迎关注小象科技频道' })), 150);
  assert(performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);
});

Deno.test('findAdEnd: danmaku targets win over the transcript; the transcript beats landing danmaku, heat and the blind step', () => {
  const subs = D.prepare(VIDEO, 900);
  const r = BAS.findAdEnd({ t: 305, duration: 900, danmaku: [], subtitles: subs });
  assertEquals(r.source, 'subtitle');
  assert(atEnd(r.end), String(r.end));
  // landing danmaku posted later (their end would be 338): the read's own end is more often right
  const landing = [[340, '欢迎回来'], [341, '欢迎回来'], [342, '空降成功']].map(([t, text]) => ({ t, text }));
  assertEquals(BAS.findAdEnd({ t: 305, duration: 900, danmaku: landing }).source, 'thanks');
  const both = BAS.findAdEnd({ t: 305, duration: 900, danmaku: landing, subtitles: subs });
  assertEquals(both.source, 'subtitle');
  assert(atEnd(both.end), String(both.end));
  const heat = { usable: true, step: 25, runs: [{ start: 275, end: 350, peakStart: 325, peakEnd: 350, n: 3, ramp: 1, peakFromEnd: 0, ratio: 9, adLike: true }] };
  assertEquals(BAS.findAdEnd({ t: 305, duration: 900, danmaku: [], subtitles: subs, heat }).source, 'subtitle');
  const dm = [[301, '空降5:25'], [302, '空降 5:25'], [303, '空降5:26']].map(([t, text]) => ({ t, text }));
  const tg = BAS.findAdEnd({ t: 305, duration: 900, danmaku: dm, subtitles: subs });
  assertEquals(tg.source, 'targets');
  assertEquals(BAS.findAdEnd({ t: 600, duration: 900, danmaku: [], subtitles: subs }).source, 'fallback');
});

Deno.test('fusion: a transcript read inside a crowd mark corroborates it; alone it is a segment of its own', () => {
  const read = D(VIDEO, 900).candidates[0];
  const crowd = { start: 299, end: 324, source: 'crowd', sources: ['crowd'], confidence: 0.9, reason: '空降助手众包标记' };
  const a = BAS.fuse({ candidates: [crowd, read], duration: 900, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  assertEquals(a.length, 1);
  assertEquals([a[0].source, a[0].start, a[0].end], ['crowd', 299, 324]);
  assert(a[0].sources.includes('subtitle') && /字幕佐证/.test(a[0].reason), a[0].reason);
  const b = BAS.fuse({ candidates: [read], duration: 900, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  assertEquals([b[0].source, b[0].autoSkip], ['subtitle', true]);
  const off = BAS.fuse({ candidates: [read], duration: 900, boundaries: [], settings: Object.assign({}, BAS.DEFAULT_SETTINGS, { useSubtitles: false }) });
  assertEquals(off.length, 0);
});

Deno.test('api: subtitle track choice and URL allow-list', async () => {
  if (!BAS.api) new Function(Deno.readTextFileSync(new URL('../src/content/22-api.js', import.meta.url)))();
  const pick = BAS.api.pickSubtitle;
  assertEquals(pick([{ lan: 'ai-en', url: 'a' }, { lan: 'ai-zh', url: 'b' }]).url, 'b');
  // the AI track first: the weights were counted from it (same sentence timing); then the uploader's own
  assertEquals(pick([{ lan: 'zh-CN', url: 'c' }, { lan: 'ai-zh', url: 'b' }]).url, 'b');
  assertEquals(pick([{ lan: 'zh-Hans', url: 'c' }, { lan: 'ai-en', url: 'a' }]).url, 'c');
  // other languages are not scored, so not downloaded
  assertEquals(pick([{ lan: 'ai-en', url: 'a' }]), null);
  assertEquals(pick([{ lan: 'ja', url: 'd' }]), null);
  let threw = false;
  try { await BAS.api.getSubtitleBody('https://evil.example.com/bfs/ai_subtitle/x.json'); } catch (e) { threw = /不受支持/.test(e.message); }
  assert(threw, 'only bilibili subtitle CDN URLs are fetched');
});

Deno.test({ name: 'detectSubtitles on held-out crowd-labelled transcripts: most ads skipped, no content cut', ignore: !HAS_CORPUS }, () => {
  // scored as the README measures it: distinct crowd ads (overlapping marks collapsed to the best-voted one), an ad is
  // found when an auto-skip overlaps it with IoU ≥ 0.4, content = auto-skipped seconds outside every visible mark ± 3 s
  const J = (rel) => JSON.parse(Deno.readTextFileSync(new URL(rel, CORPUS)));
  const labels = J('labels.json');
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  // seconds of [a, b] inside the union of the marks ± 3 s (overlapping marks counted once)
  const inside = (a, b, marks) => {
    const xs = marks.map((x) => [Math.max(a, x.s - 3), Math.min(b, x.e + 3)]).filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0]);
    let total = 0, cs = -Infinity, ce = -Infinity;
    for (const [s, e] of xs) { if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e); }
    return total + (ce > cs ? ce - cs : 0);
  };
  let ads = 0, found = 0, content = 0, videos = 0;
  for (const f of ['subs/subs1.json', 'subs/subs2.json']) {
    for (const v of J(f)) {
      if (!v.body || !v.body.length) continue;
      const last = v.body[v.body.length - 1][1];
      if (last > v.dur + 5 || last < v.dur - Math.max(60, 0.25 * v.dur)) continue;
      videos++;
      const mine = (labels[v.bv] || []).filter((s) => !s.cid || String(s.cid) === String(v.cid) || Math.abs((s.dur || 0) - v.dur) <= 2);
      const sp = mine.filter((s) => s.cat === 'sponsor' && s.act === 'skip' && !s.hidden && s.votes >= 0 && s.e - s.s >= 10)
        .sort((a, b) => (b.locked - a.locked) || (b.votes - a.votes));
      const truth = [];
      for (const s of sp) if (!truth.some((t) => ov(t.s, t.e, s.s, s.e) > 0.3 * Math.min(t.e - t.s, s.e - s.s))) truth.push(s);
      const marks = mine.filter((s) => !s.hidden && s.act !== 'full');
      const auto = D(v.body.map(([from, to, content]) => ({ from, to, content })), v.dur).candidates.filter((c) => !c.offerOnly);
      for (const t of truth) { ads++; if (auto.some((c) => { const o = ov(c.start, c.end, t.s, t.e); return o / ((c.end - c.start) + (t.e - t.s) - o) >= 0.4; })) found++; }
      for (const c of auto) content += Math.max(0, c.end - c.start - inside(c.start, c.end, marks));
    }
  }
  // measured 2026-10-27 (v2.0.0): 182 / 265 ads in 290 videos, 14 s of content
  assert(videos >= 250, `${videos} videos`);
  assert(found >= 0.62 * ads, `found ${found}/${ads}`);
  assert(content <= 60, `${Math.round(content)} s of content auto-skipped`);
});
