// Deno tests for BAS.detectDanmaku against the frame-verified ground truth in test/fixtures/expected.json.
// Run:  deno test --allow-read test/detect-danmaku.test.js
import { loadBAS, loadFullFixture, toDanmaku, loadExpected, listFixtures, hasFullFixtures } from './load.js';
// The real-danmaku corpus (test/fixtures-full/) is third-party user content and is not distributed; see README.
const HAS_CORPUS = hasFullFixtures();

let BAS;
try { BAS = loadBAS(); } catch (e) { BAS = loadBAS(['00-ns.js', '31-detect-danmaku.js']); }
const { fmtTime } = BAS.util;
const MIN_CONF = BAS.DEFAULT_SETTINGS.minConfidence;   // 0.6
const expected = loadExpected();
const settings = BAS.DEFAULT_SETTINGS;

const resultCache = new Map();
function detect(bvid) {
  if (resultCache.has(bvid)) return resultCache.get(bvid);
  const fx = loadFullFixture(bvid);
  const dm = toDanmaku(fx.dm);
  const t0 = performance.now();
  const res = BAS.detectDanmaku(dm, fx.duration, settings);
  const ms = performance.now() - t0;
  const out = { fx, dm, res, ms };
  resultCache.set(bvid, out);
  return out;
}
const isAuto = (c) => c.confidence >= MIN_CONF && !c.offerOnly && c.end != null;
const fmtCand = (c) => `${fmtTime(c.start)}-${c.end == null ? '?' : fmtTime(c.end)} conf=${c.confidence}${c.offerOnly ? ' offerOnly' : ''}`;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

Deno.test({ name: 'every expected sponsored segment is found with autoSkip-level confidence within tolerance', ignore: !HAS_CORPUS }, () => {
  const failures = [];
  for (const [bvid, segs] of Object.entries(expected.segments)) {
    const { res } = detect(bvid);
    for (const s of segs) {
      const hit = res.candidates.find((c) => isAuto(c) && Math.abs(c.start - s.start) <= s.startTol && Math.abs(c.end - s.end) <= s.endTol);
      if (!hit) failures.push(`${bvid}: expected ${fmtTime(s.start)}-${fmtTime(s.end)} (±${s.startTol}/${s.endTol}); got [${res.candidates.map(fmtCand).join(', ')}]`);
    }
  }
  assert(failures.length === 0, 'missed segments:\n  ' + failures.join('\n  '));
});

Deno.test({ name: 'negative videos never produce an autoSkip candidate', ignore: !HAS_CORPUS }, () => {
  const failures = [];
  for (const bvid of expected.negatives) {
    const { res } = detect(bvid);
    const bad = res.candidates.filter(isAuto);
    if (bad.length) failures.push(`${bvid}: ${bad.map(fmtCand).join(', ')}`);
  }
  assert(failures.length === 0, 'false positives:\n  ' + failures.join('\n  '));
});

Deno.test({ name: 'verified-not-ad offers stay below the autoSkip threshold (SPEC worked checks)', ignore: !HAS_CORPUS }, () => {
  const failures = [];
  for (const [bvid, offers] of Object.entries(expected.offersVerifiedNotAds || {})) {
    const { res } = detect(bvid);
    for (const o of offers) {
      const overlapping = res.candidates.filter((c) => c.end != null && Math.min(c.end, o.end) - Math.max(c.start, o.start) > 0);
      for (const c of overlapping) if (c.confidence > 0.55 && !c.offerOnly) failures.push(`${bvid}: ${fmtCand(c)} overlaps verified-not-ad ${fmtTime(o.start)}-${fmtTime(o.end)}`);
    }
  }
  assert(failures.length === 0, failures.join('\n'));
});

Deno.test({ name: 'opening-skip offers are reported as offerOnly or low confidence (soft: log only)', ignore: !HAS_CORPUS }, () => {
  for (const [bvid, offers] of Object.entries(expected.offers)) {
    const { res } = detect(bvid);
    for (const o of offers) {
      const endMin = o.endMin != null ? o.endMin : o.end - 15, endMax = o.endMax != null ? o.endMax : o.end + 15;
      const hit = res.candidates.find((c) => Math.abs(c.start - o.start) <= 15 && c.end != null && c.end >= endMin && c.end <= endMax);
      if (!hit) console.log(`  [soft] ${bvid}: offer ${fmtTime(o.start)}-${fmtTime(endMin)}..${fmtTime(endMax)} not reported; candidates: [${res.candidates.map(fmtCand).join(', ')}]`);
      else if (!(hit.offerOnly || hit.confidence < MIN_CONF)) console.log(`  [soft] ${bvid}: offer reported as autoSkip: ${fmtCand(hit)}`);
      else console.log(`  [ok]   ${bvid}: ${fmtCand(hit)}`);
    }
  }
});

Deno.test({ name: 'runtime stays under 80 ms per video on average over all fixtures', ignore: !HAS_CORPUS }, () => {
  const all = listFixtures(true);
  let total = 0, worst = { bvid: '', ms: 0 };
  for (const bvid of all) {
    const { ms, dm } = detect(bvid);
    total += ms;
    if (ms > worst.ms) worst = { bvid, ms, n: dm.length };
  }
  const avg = total / all.length;
  console.log(`  avg ${avg.toFixed(1)} ms/video over ${all.length} videos; worst ${worst.bvid} ${worst.ms.toFixed(1)} ms (${worst.n} danmaku)`);
  assert(avg < 80, `average runtime ${avg.toFixed(1)} ms exceeds 80 ms`);
});

Deno.test({ name: 'candidate shape follows the SPEC Candidate contract', ignore: !HAS_CORPUS }, () => {
  for (const bvid of listFixtures(true)) {
    const { res, fx } = detect(bvid);
    assert(Array.isArray(res.candidates) && res.diagnostics && Array.isArray(res.diagnostics.density), `${bvid}: bad result shape`);
    for (const c of res.candidates) {
      assert(c.source === 'danmaku', `${bvid}: source`);
      assert(typeof c.start === 'number' && c.start >= 0 && c.start <= fx.duration, `${bvid}: start ${c.start}`);
      assert(c.end === null || (typeof c.end === 'number' && c.end > c.start && c.end <= fx.duration + 1), `${bvid}: end ${c.end}`);
      assert(c.confidence >= 0 && c.confidence <= 1, `${bvid}: confidence ${c.confidence}`);
      assert(typeof c.reason === 'string' && /弹幕/.test(c.reason), `${bvid}: reason`);
      assert(c.evidence && c.evidence.startItems.length <= 30 && c.evidence.targets.length <= 30 && c.evidence.thanks.length <= 30, `${bvid}: evidence caps`);
      if (c.end == null) assert(c.confidence <= 0.45, `${bvid}: end=null must cap at 0.45 (${c.confidence})`);
      if (c.offerOnly) assert(c.confidence <= 0.5, `${bvid}: offerOnly must cap at 0.5`);
    }
  }
});

Deno.test('classify(): jump targets, number formats, negations and end markers', () => {
  const cls = BAS.detectDanmaku.classify;
  const tg = (text, t, dur, action) => cls(text, t, dur, action).targets.map((x) => x.target);
  // absolute formats (all posted at t=400 in a 2620 s video unless stated)
  assert(tg('812工程', 400, 2620)[0] === 492, '812工程');
  assert(tg('欢迎乘坐0812航班', 392, 2620)[0] === 492, '0812航班');
  assert(tg('请各位旅客前往812号登机口', 405, 2620)[0] === 492, '812号登机口');
  assert(tg('八一二工程', 404, 2620)[0] === 492, '八一二工程');
  assert(tg('折跃坐标洞四五洞', 181, 2410)[0] === 290, '洞四五洞');
  assert(tg('星语庭坐标 449', 179, 2410)[0] === 289, '坐标 449');
  assert(tg('空降6:00', 253, 2465)[0] === 360, '空降6:00');
  assert(tg('跳伞 6:00', 253, 2465)[0] === 360, '跳伞 6:00');
  assert(tg('空降兵军第十五军空降6：00', 256, 2465)[0] === 360, 'full-width colon');
  assert(tg('4；50', 182, 2410)[0] === 290, 'full-width semicolon');
  assert(tg('3:00~4:50.', 183, 2410).includes(290), 'range → last time');
  assert(tg('正片2：00', 0.7, 602)[0] === 120, '正片2：00');
  assert(tg('跳伞23:36', 1199.9, 2337, 'airborne:1416000')[0] === 1416, 'airborne action');
  assert(tg('现在是7点46分', 361, 2291)[0] === 466, 'X点Y分');
  assert(tg('6分整', 243, 2465)[0] === 360 && cls('6分整', 243, 2465).targets[0].weak, '6分整 is weak');
  // relative formats
  assert(tg('往→17下', 403.7, 2620)[0] === 488.7, '往→17下');
  assert(tg('PC端向右20下', 183.3, 2410)[0] === 283.3, 'PC端向右20下');
  assert(tg('右17', 341, 2255)[0] === 426, '右17');
  assert(tg('按21下→', 356.7, 2291)[0] === 461.7, '按21下→');
  assert(tg('16下', 405.1, 2620)[0] === 485.1, 'bare 16下');
  // rejected numbers
  assert(tg('多谢向右20下君', 359.9, 2465).length === 0, 'thanks + relative is an end marker');
  assert(tg('老师傅也是每分钟1200次吗？', 308, 2465).length === 0, '每分钟1200次');
  assert(tg('1.2万+', 364, 2291).length === 0, '万');
  assert(tg('2019年', 100, 2000).length === 0, 'year');
  assert(tg('555', 100, 2000).length === 0, '555');
  assert(tg('11点发的，11:01看到的', 6.3, 2255).length === 0, 'clock without cue');
  assert(tg('6:50要起床上班', 23.4, 651).every((v) => v === 410) && cls('6:50要起床上班', 23.4, 651).targets[0].weak, 'uncued clock is weak');
  assert(tg('P2 4:30', 10, 2000).length === 0, 'cross-part reference');
  // start classes
  assert(cls('零帧起手', 253, 2465).startW === 1, '零帧起手');
  assert(cls('无缝插播', 253, 2465).startW === 1, '无缝插播');
  assert(cls('感谢甲方催更', 257, 2465).startW === 0.5 && cls('感谢甲方催更', 257, 2465).endW === 0, '感谢甲方催更 is sponsor vocab, not an end');
  assert(cls('打钱', 100, 2000).startW === 0.5, '打钱');
  assert(cls('广告', 100, 2000).startW === 0.4, 'bare 广告');
  // negations / speculation
  for (const s of ['没有广告', '怎么还没到广告', '不会有广告吧', '是不是商单', '有没有恰饭', '广告？', '开屏广告', '坐标轴最大14000', '我怀疑这是一个广告', '整期恰饭', '以为是广告', '统一口径 不是商单', '广子要来了吗'])
    assert(cls(s, 100, 2000).startW === 0, 'negation: ' + s);
  // end markers
  for (const s of ['欢迎回来', '空降成功', '安全着陆', '谢谢810', '多谢812导航!', '感谢812工程开源', '躲过一劫', '已穿越', '回来了', '约翰那厮饱', '感谢提醒'])
    assert(cls(s, 490, 2620).endClass === 'strong', 'strong end: ' + s);
  for (const s of ['感谢600工程', '感谢空警600', '谢谢600工程', '感谢558路公交车！', '我是6分整 六分整'])
    assert(cls(s, 359.5, 2465).endClass === 'strong', 'strong end at landing: ' + s);
  for (const s of ['谢谢', '感谢', '结束了', '华子回来了', '谢谢大佬'])
    assert(cls(s, 490, 2620).endClass === 'medium', 'medium end: ' + s);
  for (const s of ['正片结束', '吃饱了撑的', '感谢金主催更', '回来看一遍'])
    assert(cls(s, 490, 2620).endW === 0, 'not an end: ' + s);
  // model numbers / letter-glued numbers are never coordinates
  for (const s of ['为啥没有测评x300Ultra', '我这手机是300', '智商250', '220V电不死250的电工', '超过1500N了'])
    assert(cls(s, 10, 2000).targets.every((x) => x.weak) || cls(s, 10, 2000).targets.length === 0, 'no trusted target: ' + s);
  assert(tg('为啥没有测评x300ultra', 0, 674).length === 0, 'x300');
  // '感谢609工程' posted far before 6:09 is a jump target, posted at 6:04 it is a landing marker
  assert(cls('感谢609工程', 264.9, 2409).targets[0] && cls('感谢609工程', 264.9, 2409).targets[0].target === 369 && cls('感谢609工程', 264.9, 2409).endClass !== 'strong', 'early 感谢609工程 → target');
  assert(cls('感谢609工程', 363.8, 2409).endClass === 'strong' && cls('感谢609工程', 363.8, 2409).targets.length === 0, 'late 感谢609工程 → end marker');
});

Deno.test('settings.extraStartKeywords / extraEndKeywords are honoured', () => {
  const dur = 1000;
  const list = [];
  for (let i = 0; i < 6; i++) list.push({ t: 100 + i * 2, text: '工商姬出没' + i });     // custom start word
  for (let i = 0; i < 3; i++) list.push({ t: 190 + i, text: '恰完饭咯' + i });            // custom end word
  const base = BAS.detectDanmaku(list, dur, Object.assign({}, BAS.DEFAULT_SETTINGS));
  const custom = BAS.detectDanmaku(list, dur, Object.assign({}, BAS.DEFAULT_SETTINGS, { extraStartKeywords: ['工商姬出没'], extraEndKeywords: ['恰完饭咯'] }));
  assert(custom.candidates.length === 1, 'custom keywords produce a candidate: ' + JSON.stringify(custom.candidates));
  const c = custom.candidates[0];
  assert(Math.abs(c.start - 99) < 1 && Math.abs(c.end - 188) < 1, 'custom candidate range ' + fmtCand(c));
  assert(c.evidence.strongEnd === 3, 'custom end keyword counts as strong');
  assert(base.candidates.length === 0 || base.candidates[0].confidence < c.confidence, 'custom keywords raise confidence');
  // bad settings must not throw
  BAS.detectDanmaku(list, dur, { extraStartKeywords: '(', extraEndKeywords: null });
  BAS.detectDanmaku(null, 0, null);
  BAS.detectDanmaku([{ t: NaN, text: null }, {}, null], 100, {});
});

Deno.test('PATTERNS is exposed for the options page', () => {
  const P = BAS.detectDanmaku.PATTERNS;
  assert(P && typeof P === 'object', 'PATTERNS object');
  for (const k of ['jump', 'announce', 'sponsor', 'negation', 'endStrong', 'endMedium']) {
    assert(P[k] && typeof P[k].label === 'string' && typeof P[k].source === 'string', 'PATTERNS.' + k);
    new RegExp(P[k].source);  // must compile
  }
});
