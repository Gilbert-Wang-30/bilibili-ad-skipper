// Tests for src/content/28-detect-subtitles.js (sponsor reads in the AI subtitles) and its use by the skip button / fusion.
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const D = BAS.detectSubtitles;
// The collected transcripts (test/fixtures-full/bsb/subs/) are third-party content and are not distributed; see README.
const CORPUS = new URL('./fixtures-full/bsb/', import.meta.url);
const HAS_CORPUS = (() => { try { Deno.statSync(new URL('subs/subs1.json', CORPUS)); return true; } catch (_) { return false; } })();

/** lines: [[from, text], ...] → subtitle body with 2 s lines */
const body = (rows) => rows.map(([from, content]) => ({ from, to: from + 2, content }));
const filler = (from, to, topic) => { const r = []; for (let t = from, i = 0; t < to; t += 3, i++) r.push([t, `${topic}第${i}段说到这里我们继续看看`]); return r; };

// a typical read: a segue, the product named a few times, then the calls to action
const READ = [
  [300, '说到熬夜剪视频'], [303, '我最近一直在用小象家的电动牙刷'], [306, '小象家电动牙刷有三种清洁模式'], [309, '刷完牙齿特别干净'],
  [312, '续航也很长充一次能用两个月'], [315, '小象家这款现在活动价只要两百多'], [318, '评论区置顶链接就能领券下单'], [321, '还有保价和运费险'],
];
const VIDEO = body([].concat(filler(0, 298, '历史'), READ, filler(324, 900, '历史')));

Deno.test('detectSubtitles: a read is found from its segue to its last call to action', () => {
  const r = D(VIDEO, 900);
  assertEquals(r.candidates.length, 1);
  const c = r.candidates[0];
  assertEquals([c.source, c.start, c.end], ['subtitle', 300, 323]);
  assert(c.confidence >= 0.75, 'two different calls to action: ' + c.confidence);
  assert(!c.offerOnly);
  assert(/置顶|链接|领券|下单/.test(c.reason) && /小象/.test(c.reason), c.reason);
});

Deno.test('detectSubtitles: a passing mention, a product review and a sale guide without calls to action are not reads', () => {
  const passing = body([].concat(filler(0, 200, '教程'), [[200, '工具的链接我放在简介里了']], filler(203, 600, '教程')));
  assertEquals(D(passing, 600).candidates.length, 0);
  const review = body([].concat(filler(0, 100, '评测'), [[100, '这款手机的屏幕是2K分辨率'], [103, '价格是四千九'], [106, '续航表现不错'], [109, '性价比很高推荐']], filler(112, 600, '评测')));
  assertEquals(D(review, 600).candidates.length, 0);
});

Deno.test('detectSubtitles: a video that sells from start to end is offered, never auto-skipped', () => {
  const rows = [];
  for (let k = 0; k < 5; k++) {
    const t0 = 20 + k * 110;
    rows.push(...filler(t0, t0 + 60, '好物'), [t0 + 60, `第${k}款宝贝叫小熊锅`], [t0 + 63, `小熊锅第${k}代`], [t0 + 66, `小熊锅链接在评论区置顶`], [t0 + 69, '领券下单还有运费险'], [t0 + 72, '这款小熊锅保价']);
  }
  const r = D(body(rows), 600);
  assert(r.candidates.length >= 1);
  assert(r.candidates.every((c) => c.offerOnly && c.confidence <= 0.5), JSON.stringify(r.candidates.map((c) => [c.start, c.end, c.offerOnly])));
});

Deno.test('detectSubtitles: English transcripts and malformed input', () => {
  const en = body([].concat(filler(0, 100, 'x'), [[100, 'This video is sponsored by Brand.'], [103, 'Use my code for a discount.'], [106, 'The link is in the description below.'], [109, 'Check it out.']], filler(112, 400, 'x')));
  const r = D(en, 400);
  assertEquals(r.candidates.length, 1);
  assertEquals(D(null, 100).candidates, []);
  assertEquals(D([{ from: 'x' }, null, { from: 5, to: 2, content: '链接' }], 100).candidates, []);
});

Deno.test('readEndAt: the end of the read playing now; nothing outside a read', () => {
  const L = D.prepare(VIDEO);
  const r = D.readEndAt(L, 310, 900);
  assertEquals([r.end, r.detected], [323, true]);
  assertEquals(D.readEndAt(L, 600, 900), null);
});

Deno.test('findAdEnd: danmaku targets win over the transcript; the transcript beats heat and the blind step', () => {
  const subs = D.prepare(VIDEO);
  const r = BAS.findAdEnd({ t: 305, duration: 900, danmaku: [], subtitles: subs });
  assertEquals([r.source, r.end], ['subtitle', 323]);
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
  assertEquals(pick([{ lan: 'ai-zh', url: 'b' }, { lan: 'zh-CN', url: 'c' }]).url, 'c');
  assertEquals(pick([{ lan: 'ja', url: 'd' }]), null);
  let threw = false;
  try { await BAS.api.getSubtitleBody('https://evil.example.com/bfs/ai_subtitle/x.json'); } catch (e) { threw = /不受支持/.test(e.message); }
  assert(threw, 'only bilibili subtitle CDN URLs are fetched');
});

Deno.test({ name: 'detectSubtitles on the crowd-labelled transcripts: most reads found, none on content', ignore: !HAS_CORPUS }, () => {
  const J = (rel) => JSON.parse(Deno.readTextFileSync(new URL(rel, CORPUS)));
  const labels = J('labels.json');
  let ads = 0, found = 0, segs = 0, onContent = 0;
  for (const v of J('subs/subs1.json')) {
    if (!v.body || !v.body.length || Math.abs(v.body[v.body.length - 1][1] - v.dur) > Math.max(30, 0.15 * v.dur)) continue;
    const truth = (labels[v.bv] || []).filter((s) => s.cat === 'sponsor' && s.act === 'skip' && !s.hidden && s.votes >= 0 && s.e - s.s >= 10);
    const r = D(v.body.map(([from, to, content]) => ({ from, to, content })), v.dur);
    for (const t of truth) { ads++; if (r.candidates.some((c) => Math.min(c.end, t.e) - Math.max(c.start, t.s) > 0.4 * (t.e - t.s))) found++; }
    for (const c of r.candidates) { segs++; if (!truth.some((t) => Math.min(c.end, t.e) > Math.max(c.start, t.s))) onContent++; }
  }
  assert(found >= 0.35 * ads, `found ${found}/${ads}`);
  assert(onContent <= Math.max(1, 0.05 * segs), `${onContent}/${segs} reads on unlabeled content`);
});
