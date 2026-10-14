// Regression tests for the verified findings of the adversarial detector review (false-positive / false-negative hunt).
import { assert } from './assert.js';
import { loadBAS, loadFullFixture, toDanmaku, hasFullFixtures } from './load.js';
// The real-danmaku corpus (test/fixtures-full/) is third-party user content and is not distributed; see README.
const HAS_CORPUS = hasFullFixtures();

const BAS = loadBAS();
const S = Object.assign({}, BAS.DEFAULT_SETTINGS);
const auto = (r) => r.candidates.filter((c) => c.confidence >= 0.6 && !c.offerOnly);
const run = (rows, dur = 900) => BAS.detectDanmaku(rows.map(([t, text]) => ({ t, text })), dur, S);
const cls = (text, t = 300, dur = 900) => BAS.detectDanmaku.classify(text, t, dur);
const filler = (from, to) => { const r = []; for (let t = from; t < to; t += 3.7) r.push([t, '哈哈哈']); return r; };

Deno.test({ name: 'generic reaction phrases and 有广东/没有广 no longer flip a verified negative to auto-skip', ignore: !HAS_CORPUS }, () => {
  const fx = loadFullFixture('BV1T7411W7ca');
  for (const extra of ['今天居然没有广', '猝不及防', '人家也是有广大的普通职工的']) {
    const rows = fx.dm.concat([[245.6, extra]]);
    const r = BAS.detectDanmaku(toDanmaku(rows), fx.duration, S);
    assert(auto(r).length === 0, `${extra} must not create an auto-skip: ` + JSON.stringify(auto(r).map((c) => [c.start, c.end, c.confidence])));
  }
});

Deno.test('surprise / 有广X / 看完广告了 clusters followed by a landing word are not ads', () => {
  const cases = [
    [[300, '画风突变'], [303, '猝不及防'], [306, '触发连招'], [380, '言归正传']],
    [[300, '有广东老乡'], [303, '有广州的兄弟'], [306, '有广西的没'], [370, '回来了']],
    [[300, '这个广告'], [303, '看完广告了'], [307, '我都跳过广告了'], [311, '这广告了解一下'], [372, '欢迎回来']],
  ];
  for (const c of cases) {
    const r = run(filler(200, 500).concat(c));
    assert(auto(r).length === 0, 'no auto-skip for ' + JSON.stringify(c) + ': ' + JSON.stringify(auto(r).map((x) => [x.start, x.end, x.confidence])));
  }
  assert(cls('有广无币').startClass === 'announce', '有广无币 is still an announcement');
});

Deno.test('number-bearing thanks are landing markers only when their time is valid and near', () => {
  assert(cls('谢谢666', 300).endClass !== 'strong', '谢谢666 is not a landing marker');
  assert(cls('感谢999', 300).endClass !== 'strong', '感谢999 is not a landing marker');
  assert(cls('谢谢810', 490).endClass === 'strong', '谢谢810 posted at 8:10 is a landing marker');
  assert(cls('感谢七分十五郎', 437).endClass === 'strong', '感谢七分十五郎 near 7:15 is a landing marker');
  assert(cls('我是七分十五郎', 436).endClass === 'strong', '我是七分十五郎 near 7:15');
  assert(cls('我是6分整 六分整', 359.5).endClass === 'strong', '我是6分整');
  assert(cls('我是阳光开朗大男孩', 300).endClass !== 'strong', '我是…开朗 is not a landing marker');
  assert(cls('我是安全工程专业的', 300).endClass !== 'strong', '我是…工程专业 is not a landing marker');
  assert(cls('我吃饱了', 300).endClass !== 'strong', 'bare 吃饱了 is not a strong end');
  assert(cls('感谢指路老板', 300).endClass === 'strong', 'landing thanks with an honorific stays a landing marker');
  assert(cls('感谢指路 2026年', 300).endClass === 'strong', 'an unrelated year does not downgrade a landing thanks');
});

Deno.test('relative arrow jumps need a press context', () => {
  const tg = (text, t = 300) => cls(text, t).targets.map((x) => x.target);
  assert(tg('8>6').length === 0, 'comparison is not a jump');
  assert(tg('左右两个都行').length === 0, '左右两个 is not a jump');
  assert(tg('右拐').length === 0, '右拐 is not a jump');
  assert(tg('向右20下')[0] === 400, '向右20下 → +100 s');
  assert(tg('右17')[0] === 385, 'bare 右17 on its own still counts');
  assert(tg('→右19下')[0] === 395, '→右19下');
});

Deno.test('bracketed clock times survive normalisation; unknown or infinite duration does not crash', () => {
  assert(cls('[4:50]', 200).targets.some((x) => x.target === 290), '[4:50] is a target');
  const rows = [[240, '空降6:00'], [241, '空降6:00'], [242, '空降 6:00'], [243, '坐标600'], [360, '欢迎回来'], [361, '欢迎回来']];
  for (const d of [Infinity, NaN, 0, 1e9]) {
    const r = run(rows, d);
    assert(!r.diagnostics.error, 'no error for duration ' + d + ': ' + r.diagnostics.error);
  }
});

Deno.test('weak-target confirmation is order-independent and bounded on spam', () => {
  const chain = [[330, '坐标745'], [340, '745'], [344, '745'], [354, '745'], [364, '745'], [374, '745'], [384, '745'], [467, '欢迎回来'], [468, '欢迎回来']];
  const r = run(chain);
  for (const c of r.candidates) assert(!(c.confidence >= 0.6), 'chained bare numbers must not reach auto-skip: ' + JSON.stringify([c.start, c.end, c.confidence]));
  const spam = filler(0, 600);
  for (let i = 0; i < 3000; i++) spam.push([200 + (i % 150) / 10, '520']);
  const t0 = performance.now();
  run(spam, 900);
  const ms = performance.now() - t0;
  assert(ms < 400, '3000 bare numbers in 15 s must stay cheap, took ' + ms.toFixed(0) + ' ms');
});

Deno.test('announcement-only ads start at the first announcement, not 6 s before it', () => {
  const dense = []; for (let t = 0; t < 900; t += 0.5) dense.push([t, '哈哈哈']);   // realistic background density
  const rows = dense.concat([[180.2, '恰饭了'], [181.3, '恰饭了'], [182.4, '恰饭了'], [183.5, '恰饭了'], [184.6, '恰饭了'], [185.7, '恰饭了'], [240.5, '恰饭结束'], [241.7, '恰饭结束'], [242.9, '恰饭结束']]);
  const a = auto(run(rows));
  assert(a.length === 1, 'one auto segment: ' + JSON.stringify(a.map((c) => [c.start, c.end, c.confidence])));
  assert(a[0].start >= 178.5 && a[0].start <= 181, 'start near the first announcement, got ' + a[0].start);
});
