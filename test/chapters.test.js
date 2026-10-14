// Tests for src/content/30-detect-chapters.js (BAS.detectChapters)
import { ok as assert, deepStrictEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert';
import { loadBAS, loadChapterFixture } from './load.js';

function bas() {
  try { return loadBAS(); } catch (_e) { return loadBAS(['00-ns.js', '30-detect-chapters.js', '33-fusion.js', '40-skipper.js']); }
}
const BAS = bas();

Deno.test('detectChapters: real ad-free chapter list yields no candidates but correct boundaries', () => {
  const fx = loadChapterFixture('BV1xVY26dEbz');
  const res = BAS.detectChapters(fx.view_points, fx.duration, BAS.DEFAULT_SETTINGS);
  assertEquals(res.candidates, []);
  assertEquals(res.boundaries, [78, 454, 768, 861, 1016, 1250, 1317]);
});

Deno.test('detectChapters: tolerates partial entries and excludes 0 / duration from boundaries', () => {
  const vps = [
    { type: 2, from: 0, to: 78, content: '开场' },
    { from: 861, to: 1016, content: '体验醋文化' },
    { content: '片尾' },
  ];
  const res = BAS.detectChapters(vps, 1333, BAS.DEFAULT_SETTINGS);
  assertEquals(res.candidates, []);
  assertEquals(res.boundaries, [78, 861, 1016]);
});

Deno.test('detectChapters: classifies synthetic titles per SPEC regex', () => {
  const titles = [
    ['广告时间', true], ['恰饭', true], ['本期赞助商', true], ['AD', true], ['ad', true], ['Sponsor', true],
    ['商务合作', true], ['金主爸爸', true], ['品牌时间', true], ['软广预警', true], ['广子', true], ['带货环节', true],
    ['广告结束', false], ['无广告', false], ['没有广告', false], ['非广告', false], ['正片', false], ['正片开始', false],
    ['开场', false], ['总结', false], ['片尾', false], ['head', false], ['bad', false], ['load', false],
    ['', false], [null, false], [undefined, false],
  ];
  for (const [title, expected] of titles) {
    assertStrictEquals(BAS.detectChapters.isAdChapterTitle(title, BAS.DEFAULT_SETTINGS), expected, `title=${title}`);
  }
  const vps = [
    { type: 2, from: 0, to: 60, content: '开场' },
    { type: 2, from: 60, to: 120, content: '广告时间' },
    { type: 2, from: 120, to: 200, content: '恰饭' },
    { type: 2, from: 200, to: 260, content: '本期赞助商' },
    { type: 2, from: 260, to: 300, content: 'AD' },
    { type: 2, from: 300, to: 400, content: '广告结束' },
    { type: 2, from: 400, to: 500, content: '无广告' },
  ];
  const res = BAS.detectChapters(vps, 500, BAS.DEFAULT_SETTINGS);
  assertEquals(res.candidates.map((c) => [c.start, c.end]), [[60, 120], [120, 200], [200, 260], [260, 300]]);
  for (const c of res.candidates) {
    assertStrictEquals(c.source, 'chapter');
    assertStrictEquals(c.confidence, 0.95);
    assert(c.reason.startsWith('章节「') && c.reason.endsWith('」'), c.reason);
    assert(c.end === null || typeof c.end === 'number');
  }
  assertEquals(res.candidates[0].reason, '章节「广告时间」');
  assertEquals(res.boundaries, [60, 120, 200, 260, 300, 400]);
});

Deno.test('detectChapters: normalizes full-width text and case', () => {
  const res = BAS.detectChapters([{ type: 2, from: 10, to: 40, content: 'ＡＤ ［doge］' }], 100, {});
  assertEquals(res.candidates.length, 1);
  const res2 = BAS.detectChapters([{ type: 2, from: 10, to: 40, content: 'SPONSOR segment' }], 100, {});
  assertEquals(res2.candidates.length, 1);
});

Deno.test('detectChapters: drops ad chapters shorter than 3 s or longer than 600 s', () => {
  const vps = [
    { type: 2, from: 0, to: 2, content: '广告' },        // too short
    { type: 2, from: 2, to: 700, content: '广告' },      // too long
    { type: 2, from: 700, to: 703, content: '广告' },    // exactly 3 s -> kept
    { type: 2, from: 703, to: 1303, content: '恰饭' },   // exactly 600 s -> kept
  ];
  const res = BAS.detectChapters(vps, 1400, BAS.DEFAULT_SETTINGS);
  assertEquals(res.candidates.map((c) => [c.start, c.end]), [[700, 703], [703, 1303]]);
  assertEquals(res.boundaries, [2, 700, 703, 1303]);
});

Deno.test('detectChapters: honours settings.extraStartKeywords as substrings', () => {
  const vps = [{ type: 2, from: 30, to: 90, content: '感谢XX支持' }];
  assertEquals(BAS.detectChapters(vps, 300, BAS.DEFAULT_SETTINGS).candidates.length, 0);
  const res = BAS.detectChapters(vps, 300, { extraStartKeywords: ['XX支持'] });
  assertEquals(res.candidates.length, 1);
});

Deno.test('detectChapters: robust to garbage input', () => {
  assertEquals(BAS.detectChapters(null, 100, {}), { candidates: [], boundaries: [] });
  assertEquals(BAS.detectChapters(undefined, undefined, undefined), { candidates: [], boundaries: [] });
  assertEquals(BAS.detectChapters('nope', 100, {}), { candidates: [], boundaries: [] });
  const res = BAS.detectChapters([null, 5, 'x', { from: 'a', to: 'b', content: '广告' }, { from: '10', to: '50', content: '广告' }], 100, {});
  assertEquals(res.candidates.map((c) => [c.start, c.end]), [[10, 50]]);
  assertEquals(res.boundaries, [10, 50]);
  // Values outside the video are clamped, reversed ranges fixed, NaN duration tolerated.
  const res2 = BAS.detectChapters([{ from: 90, to: 20, content: '广告' }, { from: -5, to: 150, content: 'x' }], 100, {});
  assertEquals(res2.candidates.map((c) => [c.start, c.end]), [[20, 90]]);
  assertEquals(res2.boundaries, [20, 90]);
  const res3 = BAS.detectChapters([{ from: 20, to: 90, content: '广告' }], NaN, {});
  assertEquals(res3.candidates.length, 1);
  assertEquals(res3.boundaries, [20, 90]);
});

Deno.test('detectChapters: real fixture with view_points runs without throwing', () => {
  const fx = loadChapterFixture('BV1xVY26dEbz');
  for (const vp of fx.view_points) assert(typeof vp.content === 'string');
  const res = BAS.detectChapters(fx.view_points, fx.duration, BAS.DEFAULT_SETTINGS);
  assert(Array.isArray(res.candidates) && Array.isArray(res.boundaries));
});
