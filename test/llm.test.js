// Tests for src/content/29-detect-llm.js (request building + answer validation) and src/llm-providers.js (wire formats).
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const L = BAS.detectLlm;
new Function(Deno.readTextFileSync(new URL('../src/llm-providers.js', import.meta.url)))();
const P = globalThis.BAS_LLM_PROVIDERS;

const LINES = ['今天聊聊黑洞', '恒星坍缩', '说到熬夜', '我最近在用小象家的台灯', '评论区置顶链接领券下单', '好了回到正题', '黑洞形成了'].map((t, i) => ({ from: i * 10, to: i * 10 + 8, content: t }));
const req = L.buildRequest({ title: '黑洞', duration: 70, lines: LINES });
const seg = (o) => Object.assign({ first: 2, last: 4, kind: 'sponsor', product: '小象家台灯', confidence: 0.95, first_quote: '说到熬夜', last_quote: '评论区置顶' }, o);
const reply = (segments, extra) => JSON.stringify(Object.assign({ segments, whole_video_commercial: false }, extra));

Deno.test('buildRequest: numbered lines with times, title and duration; schema and version', () => {
  assert(req.user.startsWith('Title: 黑洞\nDuration: 1:10\nTranscript (7 lines):\n0|0:00|今天聊聊黑洞\n'), req.user.slice(0, 80));
  assert(req.user.includes('\n4|0:40|评论区置顶链接领券下单'));
  assertEquals([req.lines.length, req.version, req.truncated], [7, L.PROMPT_VERSION, false]);
  assert(/first_quote/.test(req.system) && req.schema.required.includes('segments'));
  // a "|" or newline in a subtitle cannot break the line format
  const odd = L.buildRequest({ lines: [{ from: 0, to: 1, content: 'a|b\nc' }] });
  assert(odd.user.endsWith('0|0:00|a b c'), odd.user);
});

Deno.test('parseReply: a confident sponsor read becomes an auto-skip with sentence-exact edges', () => {
  const r = L.parseReply(reply([seg()]), req);
  assertEquals(r.candidates.length, 1);
  const c = r.candidates[0];
  assertEquals([c.source, c.start, c.end, !!c.offerOnly], ['llm', 20, 48, false]);
  assert(c.confidence >= 0.9 && /小象家台灯/.test(c.reason));
  // fenced JSON and leading prose are tolerated
  assertEquals(L.parseReply('好的：\n```json\n' + reply([seg()]) + '\n```', req).candidates.length, 1);
});

Deno.test('parseReply: the auto-skip threshold is per model (Opus rates its reads more cautiously than Haiku)', () => {
  assertEquals([L.autoConfidenceFor('claude-opus-5-5'), L.autoConfidenceFor('claude-haiku-5-5'), L.autoConfidenceFor('qwen-flash')], [0.75, 0.85, 0.85]);
  const opus = L.buildRequest({ duration: 70, lines: LINES, model: 'claude-opus-5-5' });
  assert(!L.parseReply(reply([seg({ confidence: 0.8 })]), opus).candidates[0].offerOnly);
  assert(L.parseReply(reply([seg({ confidence: 0.8 })]), req).candidates[0].offerOnly);
});

Deno.test('parseReply: unsure / low confidence / whole-video-commercial are offered, never skipped', () => {
  assert(L.parseReply(reply([seg({ kind: 'unsure', confidence: 0.6 })]), req).candidates[0].offerOnly);
  assert(L.parseReply(reply([seg({ confidence: 0.7 })]), req).candidates[0].offerOnly);
  const w = L.parseReply(reply([seg()], { whole_video_commercial: true }), req).candidates[0];
  assert(w.offerOnly && w.confidence <= 0.55);
});

Deno.test('parseReply: answers that do not fit the transcript are rejected', () => {
  const rej = (s) => { const r = L.parseReply(reply([s]), req); return [r.candidates.length, r.rejected[0] && r.rejected[0].reason]; };
  assertEquals(rej(seg({ last: 9 })), [0, '行号越界']);
  assertEquals(rej(seg({ first_quote: '完全不相干的话' })), [0, '引用与字幕不符']);
  assertEquals(rej(seg({ kind: 'self_promo' })), [0, 'UP 主自荐']);
  assertEquals(rej(seg({ first: 0, last: 5, first_quote: '今天', last_quote: '好了' })), [0, '超过半个视频']);
  // quotes are required: an answer without them proves nothing about its line numbers
  assertEquals(rej(seg({ first_quote: '' })), [0, '引用与字幕不符']);
  assertEquals(rej(seg({ last_quote: undefined })), [0, '引用与字幕不符']);
  assertEquals(rej(seg({ first: null })), [0, '行号无效']);
  // reversed indices are fixed, not rejected
  assertEquals(L.parseReply(reply([seg({ first: 4, last: 2, first_quote: '评论区', last_quote: '说到' })]), req).candidates.length, 1);
  assert(L.parseReply('not json', req).error);
  assertEquals(L.parseReply(reply([]), req).candidates, []);
});

Deno.test('parseReply: an invented kind is offered; many or long reads are all offered, never one long skip', () => {
  const k = L.parseReply(reply([seg({ kind: 'not_ad' })]), req).candidates[0];
  assert(k.offerOnly && k.evidence.llm.kind === 'unsure');
  // 100 lines of 6 s: two touching reads that together cover the whole video
  const LONG = Array.from({ length: 100 }, (_, i) => ({ from: i * 6, to: i * 6 + 6, content: '这是第' + i + '句' }));
  const lreq = L.buildRequest({ duration: 600, lines: LONG });
  const two = L.parseReply(reply([seg({ first: 0, last: 49, first_quote: '这是第0句', last_quote: '这是第49句' }), seg({ first: 50, last: 99, first_quote: '这是第50句', last_quote: '这是第99句' })]), lreq).candidates;
  assertEquals(two.length, 2);
  assert(two.every((c) => c.offerOnly && c.confidence <= 0.55), JSON.stringify(two.map((c) => [c.start, c.end, c.offerOnly])));
  // one read over 6 minutes is offered
  const L2 = Array.from({ length: 100 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, content: '第' + i + '句话' }));
  const big = L.parseReply(reply([seg({ first: 10, last: 49, first_quote: '第10句话', last_quote: '第49句话' })]), L.buildRequest({ duration: 1000, lines: L2 })).candidates[0];
  assert(big.offerOnly && big.end - big.start === 400);
  // two normal reads in a long video stay auto-skips
  const ok = L.parseReply(reply([seg({ first: 10, last: 14, first_quote: '第10句话', last_quote: '第14句话' }), seg({ first: 60, last: 66, first_quote: '第60句话', last_quote: '第66句话' })]), L.buildRequest({ duration: 1000, lines: L2 })).candidates;
  assert(ok.length === 2 && ok.every((c) => !c.offerOnly));
});

Deno.test('fingerprint: same transcript same key, edited transcript new key', () => {
  assertEquals(L.fingerprint(LINES), L.fingerprint(LINES.map((x) => Object.assign({}, x))));
  assert(L.fingerprint(LINES) !== L.fingerprint(LINES.slice(1)));
  // same number of lines, one line re-transcribed
  const edited = LINES.map((x, i) => (i === 0 ? Object.assign({}, x, { content: '今天聊聊白洞' }) : x));
  assert(L.fingerprint(LINES) !== L.fingerprint(edited));
});

Deno.test('buildRequest: a very long transcript is cut and says so', () => {
  const many = Array.from({ length: L.CONST.MAX_LINES + 50 }, (_, i) => ({ from: i, to: i + 1, content: '句' + i }));
  const r = L.buildRequest({ lines: many });
  assertEquals([r.lines.length, r.truncated], [L.CONST.MAX_LINES, true]);
});

const L2 = Array.from({ length: 300 }, (_, i) => ({ from: i * 4, to: i * 4 + 4, content: '第' + i + '句话' }));
const req2 = L.buildRequest({ duration: 1200, lines: L2 });
const at = (f, l, o) => seg(Object.assign({ first: f, last: l, first_quote: '第' + f + '句话', last_quote: '第' + l + '句话' }, o));

Deno.test('capAuto: more than five confident reads are all offered', () => {
  const six = L.parseReply(reply([0, 40, 80, 120, 160, 200].map((f) => at(f, f + 4))), req2).candidates;
  assertEquals(six.length, 6);
  assert(six.every((c) => c.offerOnly), 'six reads → offers');
  const five = L.parseReply(reply([0, 40, 80, 120, 160].map((f) => at(f, f + 4))), req2).candidates;
  assert(five.every((c) => !c.offerOnly), 'five short reads stay skips');
});

Deno.test('second question: confirm / reject / unsure / out of range, and the caps still apply after it', () => {
  const first = L.parseReply(reply([at(100, 110, { kind: 'unsure', confidence: 0.5 })]), req2);
  const c = first.candidates[0];
  assert(c.offerOnly && c.evidence.llm.uncertain);
  const v = L.buildVerifyRequest(req2, c, 't');
  assert(v.user.includes('Flagged lines: 100–110') && v.user.includes('\n75|') && v.user.includes('\n135|') && !v.user.includes('\n136|'));
  const ans = (o) => JSON.stringify(Object.assign({ verdict: 'sponsor', first: 98, last: 112, first_quote: '第98句话', last_quote: '第112句话', confidence: 0.95 }, o));
  const yes = L.parseVerifyReply(ans(), v, req2);
  assertEquals([yes.start, yes.end, !!yes.offerOnly, yes.evidence.llm.verified], [392, 452, false, true]);
  assertEquals(L.parseVerifyReply(ans({ verdict: 'not_sponsor' }), v, req2), null);
  assertEquals(L.parseVerifyReply(ans({ verdict: 'unsure' }), v, req2), c);
  assertEquals(L.parseVerifyReply(ans({ first: 10, last: 20, first_quote: '第10句话', last_quote: '第20句话' }), v, req2), c);   // outside the passage
  assertEquals(L.parseVerifyReply('garbage', v, req2), c);
  // five confident reads + one confirmed by the second question: the final list is capped
  const list = L.parseReply(reply([0, 40, 80, 120, 160].map((f) => at(f, f + 4))), req2).candidates.concat([yes]);
  assert(L.capAuto(list, 1200).every((x) => x.offerOnly && !x.evidence.llm.uncertain));
  // a capped first answer asks no second question
  const capped = L.parseReply(reply([0, 40, 80, 120, 160, 200].map((f) => at(f, f + 4)).concat([at(250, 260, { kind: 'unsure', confidence: 0.5 })])), req2).candidates;
  assert(capped.every((x) => !x.evidence.llm.uncertain));
});

Deno.test('fusion: an offered model read touching a skip does not widen it', () => {
  const auto = L.parseReply(reply([at(10, 14)]), req2).candidates[0];
  const longOffer = L.parseReply(reply([at(14, 160, { kind: 'unsure', confidence: 0.5 })]), req2).candidates[0];
  assert(!auto.offerOnly && longOffer.offerOnly);
  const out = BAS.fuse({ candidates: [auto, longOffer], duration: 1200, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  const skip = out.filter((s) => s.autoSkip);
  assertEquals(skip.length, 1);
  assertEquals([skip[0].start, skip[0].end], [auto.start, auto.end]);
});

Deno.test('providers: config validation keeps keys on https (or this machine)', () => {
  assertEquals(P.normalizeConfig({ provider: 'anthropic', apiKey: 'k' }).model, 'claude-opus-5-5');
  assertEquals(P.normalizeConfig({ provider: 'anthropic' }), null);                                   // no key
  assertEquals(P.normalizeConfig({ provider: 'custom', baseUrl: 'http://example.com/v1', model: 'm' }), null);   // plain http
  assert(P.normalizeConfig({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen' }));
  assertEquals(P.normalizeConfig({ provider: 'nope', apiKey: 'k' }), null);
  assertEquals(P.originPattern(P.normalizeConfig({ provider: 'deepseek', apiKey: 'k' })), 'https://api.deepseek.com/*');
});

Deno.test('providers: Anthropic and OpenAI-compatible request bodies', () => {
  const a = P.buildHttp(P.normalizeConfig({ provider: 'anthropic', apiKey: 'sk-ant-x' }), { system: 'S', user: 'U', schema: L.SCHEMA });
  const ab = JSON.parse(a.init.body);
  assertEquals(a.url, 'https://api.anthropic.com/v1/messages');
  assertEquals([a.init.headers['x-api-key'], a.init.headers['anthropic-version'], a.init.headers['anthropic-dangerous-direct-browser-access']], ['sk-ant-x', P.ANTHROPIC_VERSION, 'true']);
  assertEquals([ab.model, ab.system, ab.messages[0].content, ab.output_config.effort, ab.output_config.format.type], ['claude-opus-5-5', 'S', 'U', 'low', 'json_schema']);
  assert(!('temperature' in ab) && !('thinking' in ab));
  assertEquals([ab.fallbacks, a.init.headers['anthropic-beta']], ['default', 'server-side-fallback-2026-07-01']);
  const hk = P.buildHttp(P.normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5' }), { system: 'S', user: 'U', schema: L.SCHEMA });
  assert(!('fallbacks' in JSON.parse(hk.init.body)) && !hk.init.headers['anthropic-beta'] && JSON.parse(hk.init.body).output_config.effort === 'low');
  const d = P.buildHttp(P.normalizeConfig({ provider: 'deepseek', apiKey: 'k' }), { system: 'S', user: 'U' });
  const db = JSON.parse(d.init.body);
  assertEquals([d.url, d.init.headers.authorization, db.response_format.type, db.thinking.type, db.temperature, db.messages[0].role], ['https://api.deepseek.com/chat/completions', 'Bearer k', 'json_object', 'disabled', 0, 'system']);
  const o = JSON.parse(P.buildHttp(P.normalizeConfig({ provider: 'openai', apiKey: 'k' }), { system: 'S', user: 'U' }).init.body);
  assert(!('temperature' in o) && o.max_completion_tokens >= 16000 && !('max_tokens' in o) && o.reasoning_effort === 'minimal');
  // thinking can be switched off only on Gemini 2.5 Flash; the 3.x default and non-reasoning OpenAI models get no flag
  assertEquals(JSON.parse(P.buildHttp(P.normalizeConfig({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' }), { system: 'S', user: 'U' }).init.body).reasoning_effort, 'none');
  assert(!('reasoning_effort' in JSON.parse(P.buildHttp(P.normalizeConfig({ provider: 'gemini', apiKey: 'k' }), { system: 'S', user: 'U' }).init.body)));
  assert(!('reasoning_effort' in JSON.parse(P.buildHttp(P.normalizeConfig({ provider: 'openai', apiKey: 'k', model: 'gpt-4.1-mini' }), { system: 'S', user: 'U' }).init.body)));
  // effort only where the model accepts it
  assert(P.supportsEffort('claude-haiku-5-5') && P.supportsEffort('claude-sonnet-4-6') && P.supportsEffort('claude-opus-5-5'));
  assert(!P.supportsEffort('claude-haiku-4-5') && !P.supportsEffort('claude-sonnet-4-5') && !P.supportsEffort('gpt-5-mini'));
  const old = JSON.parse(P.buildHttp(P.normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5' }), { system: 'S', user: 'U', schema: L.SCHEMA }).init.body);
  assert(!('effort' in old.output_config) && old.output_config.format.type === 'json_schema');
  assertEquals(P.normalizeConfig({ provider: 'custom', baseUrl: 'http://[::1]:11434/v1', model: 'm' }), null);
  assertEquals(a.init.credentials, 'omit');
});

Deno.test('providers: replies, errors and refusals', () => {
  const ca = P.normalizeConfig({ provider: 'anthropic', apiKey: 'k' });
  assertEquals(P.parseHttp(ca, 200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"segments":[]}' }], stop_reason: 'end_turn' }), { ok: true, text: '{"segments":[]}', usage: null });
  assertEquals(P.parseHttp(ca, 200, { content: [], stop_reason: 'refusal' }).ok, false);
  assert(/密钥/.test(P.parseHttp(ca, 401, { type: 'error', error: { message: 'invalid x-api-key' } }).error));
  assertEquals(P.parseHttp(ca, 529, null).retry, true);
  const co = P.normalizeConfig({ provider: 'qwen', apiKey: 'k' });
  assertEquals(P.parseHttp(co, 200, { choices: [{ message: { content: '{}' } }] }).text, '{}');
  assertEquals(P.parseHttp(co, 400, { error: { message: 'bad model' } }).retry, false);
  // a reply cut at the token cap is not retried (it would be cut again, and billed again)
  const cut = P.parseHttp(co, 200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  assertEquals([cut.ok, cut.retry], [false, false]);
  assertEquals(P.parseHttp(ca, 200, { content: [{ type: 'text', text: '{"seg' }], stop_reason: 'max_tokens' }).retry, false);
  // Gemini wraps errors in an array; a keyless local server that refuses the origin is not "a bad key"
  assert(/API key not valid/.test(P.parseHttp(P.normalizeConfig({ provider: 'gemini', apiKey: 'k' }), 400, [{ error: { message: 'API key not valid.' } }]).error));
  assert(/OLLAMA_ORIGINS/.test(P.parseHttp(P.normalizeConfig({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'm' }), 403, null).error));
});

Deno.test('fusion: a model read hosts the danmaku estimates around it and auto-skips', () => {
  const c = L.parseReply(reply([seg()]), req).candidates[0];
  const dm = { start: 22, end: 60, source: 'danmaku', sources: ['danmaku'], confidence: 0.4, reason: '弹幕' };
  const out = BAS.fuse({ candidates: [c, dm], duration: 70, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  assertEquals(out.length, 1);
  assertEquals([out[0].source, out[0].start, out[0].end, out[0].autoSkip], ['llm', 20, 48, true]);
  assert(out[0].sources.includes('danmaku'));
  assertEquals(BAS.fuse({ candidates: [c], duration: 70, boundaries: [], settings: Object.assign({}, BAS.DEFAULT_SETTINGS, { useLlm: false }) }).length, 0);
});
