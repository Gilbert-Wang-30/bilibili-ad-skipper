// Tests for the one-source gate of 38-pipeline.js (v4.2.0): an auto-skip needs two kinds of evidence, unless its one
// kind is strong on its own; otherwise it is offered (the skip button).
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const S = BAS.DEFAULT_SETTINGS;
const run = (cands) => BAS.buildSegments({ candidates: cands, duration: 900, boundaries: [], settings: S }).segments.filter((s) => !s.ignored);
const crowd = (votes, extra) => Object.assign({ start: 300, end: 360, source: 'crowd', sources: ['crowd'], confidence: votes >= 1 ? 0.95 : 0.9, reason: '空降助手众包标记', evidence: { crowd: { votes, locked: false } } }, extra);
const sub = (p) => ({ start: 300, end: 360, source: 'subtitle', sources: ['subtitle'], confidence: 0.7 + 0.25 * p, reason: `字幕：口播（${Math.round(p * 100)}%）`, evidence: { subtitle: { p } } });
const net = (p) => ({ start: 300, end: 360, source: 'danmaku', sources: ['danmaku'], confidence: 0.85, reason: '弹幕/热度模型', evidence: { bins: { p, net: true } } });
const rules = (n) => ({ start: 300, end: 360, source: 'danmaku', sources: ['danmaku'], confidence: 0.8, reason: '弹幕', evidence: { targetsAgree: n } });

Deno.test('gate: a crowd mark nobody voted on alone is offered; with a vote, or with a detector agreeing, it skips', () => {
  const a = run([crowd(0)]);
  assertEquals([a.length, a[0].autoSkip, a[0].oneSource], [1, false, true]);
  assert(/仅单一来源/.test(a[0].reason), a[0].reason);
  assertEquals(run([crowd(1)])[0].autoSkip, true);
  assertEquals(run([crowd(0, { evidence: { crowd: { votes: 0, locked: true } } })])[0].autoSkip, true);
  const both = run([crowd(0), sub(0.8)]);
  assertEquals([both.length, both[0].autoSkip], [1, true]);
});

Deno.test('gate: a subtitle read alone skips only when the model is at least 90 % sure', () => {
  assertEquals(run([sub(0.85)])[0].autoSkip, false);
  assertEquals(run([sub(0.95)])[0].autoSkip, true);
});

Deno.test('gate: danmaku alone — the network at 95 %, or three agreeing coordinates', () => {
  assertEquals(run([net(0.92)])[0].autoSkip, false);
  assertEquals(run([net(0.97)])[0].autoSkip, true);
  assertEquals(run([rules(2)])[0].autoSkip, false);
  assertEquals(run([rules(3)])[0].autoSkip, true);
  // a chapter and a user segment are strong alone; an offer stays an offer
  assertEquals(run([{ start: 300, end: 360, source: 'chapter', sources: ['chapter'], confidence: 0.95, reason: '章节' }])[0].autoSkip, true);
  assertEquals(run([Object.assign(sub(0.95), { offerOnly: true, confidence: 0.5 })])[0].autoSkip, false);
});

Deno.test('danmaku: the video\'s own coordinate meme (no cue word) counts when viewers land there; repeated numbers alone do not', () => {
  const bg = []; for (let t = 0; t < 900; t += 2.5) bg.push({ t, text: '哈哈哈' });
  const memes = [[402, '745冲'], [404, '745走起'], [405, '745冲'], [409, '745是好地方'], [415, '745见']].map(([t, text]) => ({ t, text }));
  const land = [[467, '欢迎回来'], [468, '欢迎回来'], [470, '回来了']].map(([t, text]) => ({ t, text }));
  const D = BAS.detectDanmaku;
  const withLanding = D(bg.concat(memes, land).sort((a, b) => a.t - b.t), 900, S).candidates;
  assert(withLanding.some((c) => c.end === 465 && c.evidence.targetsAgree >= 4), JSON.stringify(withLanding.map((c) => [c.start, c.end])));
  const noLanding = D(bg.concat(memes).sort((a, b) => a.t - b.t), 900, S).candidates;
  assert(!noLanding.some((c) => c.end === 465 && !c.offerOnly && c.confidence >= S.minConfidence), JSON.stringify(noLanding.map((c) => [c.start, c.end, c.confidence])));
});
