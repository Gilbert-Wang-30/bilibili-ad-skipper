/* Bilibili Ad Skipper — sponsored segments read from the transcript by a language model (the viewer's own API key).
 *
 * The model gets the video title and the AI subtitles as numbered lines and answers with line ranges; this module
 * builds that request and checks the answer (lines exist, quoted text is really there, sane length) before any of it
 * becomes a candidate. Line-indexed answers make the edges sentence-exact. Measured on 76 crowd-labelled videos with
 * a small model (Claude Haiku class): 97 % of labelled ads found (IoU ≥ 0.4), start / end a median 0.0 / −0.1 s from
 * the label. Pure; no DOM / chrome.* (the request itself goes through the background worker, 50-main.js).
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectLlm) return;

  const PROMPT_VERSION = 1;
  const MAX_LINES = 4000;        // ~3 h of speech; longer transcripts are cut (the tail rarely holds the only ad)
  const MAX_CHARS = 120000;
  const MIN_LEN = 4;             // seconds
  const MAX_SHARE = 0.5;         // a "segment" longer than half the video is the video itself
  const AUTO_CONFIDENCE = 0.85;  // the model's own confidence needed for an auto-skip …
  // … calibrated per model on the crowd-labelled transcripts: Claude Opus / Sonnet / Fable rate their reads lower than
  // Haiku does (Opus: 10 of 11 reads at 0.75–0.85 were crowd-marked ads), so they skip from 0.75
  const autoConfidenceFor = (model) => (/^claude-(opus|sonnet|fable|mythos)/.test(String(model || '')) ? 0.75 : AUTO_CONFIDENCE);
  const MAX_AUTO_LEN = 360;      // s: a longer read is offered, never skipped on the model's word alone
  const MAX_AUTO_SHARE = 0.4;    // reads covering more of the video than this, or more than MAX_AUTO_READS of them,
  const MAX_AUTO_READS = 5;      // are all offered: a shopping video, a model mistake or an instruction hidden in the text
  const VERIFY_CONTEXT = 25;     // lines on each side of an uncertain read sent with the second question
  const VERIFY_MIN_CONFIDENCE = 0.1;
  const MAX_VERIFY = 3;          // second questions per video

  const SYSTEM = [
    'You annotate bilibili videos for an ad-skipping browser extension. You get the title and the AI-generated subtitle transcript of one video as numbered lines "<n>|<m:ss>|<text>". Transcription errors (homophones, misspelled brands) are common; read through them.',
    '',
    'Find every INSERTED SPONSORED SEGMENT (恰饭 / 商单 / 推广 / 植入广告): a stretch where the uploader leaves the video\'s own content to promote a third party\'s product, service, app, game, shop, platform campaign or event — usually with a segue ("说到…", "话说回来…", "本期视频由…", "今天的推广位…") and often a call to action (链接 / 评论区置顶 / 领券 / 下单 / 搜索 / 下载 / 活动价). A read without a call to action (only praise and "感兴趣可以去看看") still counts. A short sponsor thank-you or reminder near the end counts as its own segment.',
    '',
    'Boundaries (how viewers mark skippable segments):',
    '- first = the first line of the segue that starts steering toward the product (an ad can start before the brand is named); not earlier content.',
    '- last = the last line about the promotion (its closing call to action, or a "好了，回到正题" line); the first sentence back on the topic is content.',
    '- The same brand coming back after real content is a separate segment.',
    '',
    'Not a sponsored segment:',
    '- the video\'s own topic, even when it is a product (a review, an unboxing, the game the video is about, news about a company);',
    '- the uploader\'s own channel requests (三连 / 关注 / 充电), merch, courses or other channels → kind "self_promo";',
    '- brand names mentioned in passing, jokes about ads, quoted ads that are part of the story.',
    'When unsure, use kind "unsure" with an honest confidence. If the whole video is itself commercial (a shopping guide, a sponsored review from start to end), set whole_video_commercial and still list inserted reads.',
    '',
    'Answer with JSON only, exactly this shape:',
    '{"segments":[{"first":<line n>,"last":<line n>,"kind":"sponsor"|"self_promo"|"unsure","product":"<brand or product>","confidence":<0..1>,"first_quote":"<a few words copied from line first>","last_quote":"<a few words copied from line last>"}],"whole_video_commercial":<true|false>}',
    'An empty "segments" list is a valid answer.',
  ].join('\n');

  const SCHEMA = {
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            first: { type: 'integer' }, last: { type: 'integer' },
            kind: { type: 'string', enum: ['sponsor', 'self_promo', 'unsure'] },
            product: { type: 'string' }, confidence: { type: 'number' },
            first_quote: { type: 'string' }, last_quote: { type: 'string' },
          },
          required: ['first', 'last', 'kind', 'product', 'confidence', 'first_quote', 'last_quote'],
          additionalProperties: false,
        },
      },
      whole_video_commercial: { type: 'boolean' },
    },
    required: ['segments', 'whole_video_commercial'],
    additionalProperties: false,
  };

  const mmss = (t) => { const s = Math.max(0, Math.floor(t)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const clean = (t) => String(t == null ? '' : t).replace(/[\r\n|]+/g, ' ').trim();
  const norm = (t) => String(t == null ? '' : t).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();

  /** Subtitle body → [{a, b, text}] sorted, malformed lines dropped. */
  function toLines(body) {
    const out = [];
    for (const r of Array.isArray(body) ? body : []) {
      const a = +(r && (r.from != null ? r.from : r[0])), b = +(r && (r.to != null ? r.to : r[1]));
      const text = r && (r.content != null ? r.content : r[2]);
      if (!isFinite(a) || !isFinite(b) || b < a || typeof text !== 'string') continue;
      out.push({ a, b, text: clean(text) });
    }
    return out.sort((x, y) => x.a - y.a);
  }

  /**
   * @param {{title?:string, duration?:number, lines:Array, hints?:string[]}} video  lines = subtitle body or toLines()
   * @returns {{system:string, user:string, schema:object, lines:Array, version:number, truncated:boolean}}
   */
  function buildRequest(video) {
    const lines = toLines(video && video.lines);
    let chars = 0, n = 0;
    const rows = [];
    for (const l of lines) {
      if (n >= MAX_LINES || chars > MAX_CHARS) break;
      const row = `${n}|${mmss(l.a)}|${l.text}`;
      rows.push(row); chars += row.length + 1; n++;
    }
    const head = [`Title: ${clean(video && video.title).slice(0, 200)}`];
    if (video && video.duration > 0) head.push(`Duration: ${mmss(video.duration)}`);
    for (const h of (video && Array.isArray(video.hints) ? video.hints : []).slice(0, 4)) head.push(clean(h).slice(0, 300));
    head.push(`Transcript (${rows.length} lines):`);
    return { system: SYSTEM, user: head.join('\n') + '\n' + rows.join('\n'), schema: SCHEMA, lines: lines.slice(0, rows.length), duration: video && video.duration > 0 ? +video.duration : 0, version: PROMPT_VERSION, truncated: rows.length < lines.length, autoConfidence: autoConfidenceFor(video && video.model) };
  }

  /** A JSON object from a model reply: plain JSON, fenced JSON, or the first {...} block. */
  function extractJson(reply) {
    if (reply && typeof reply === 'object') return reply;
    const s = String(reply == null ? '' : reply).trim();
    const tries = [s, (s.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], (() => { const i = s.indexOf('{'), j = s.lastIndexOf('}'); return i >= 0 && j > i ? s.slice(i, j + 1) : null; })()];
    for (const t of tries) { if (!t) continue; try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch (e) { /* next */ } }
    return null;
  }

  /** Does `quote` appear (punctuation/space-insensitive) in lines [i - 1, i + 1]? A quote is required. */
  function quoteNear(lines, i, quote) {
    const q = norm(quote);
    if (q.length < 2) return false;
    const probe = q.length > 6 ? q.slice(0, 6) : q;
    for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) if (norm(lines[k].text).includes(probe)) return true;
    return false;
  }

  /**
   * Model reply → validated candidates.
   * @param {*} reply  the reply text (or parsed object)
   * @param {{lines:Array, duration?:number}} req  the request it answers (buildRequest result)
   * @param {object} [settings]
   * @returns {{candidates: object[], rejected: object[], commercial: boolean, error?: string}}
   */
  function parseReply(reply, req, settings) {
    const lines = req && Array.isArray(req.lines) ? req.lines : [];
    const dur = req && req.duration > 0 ? req.duration : (lines.length ? lines[lines.length - 1].b : 0);
    const j = extractJson(reply);
    if (!j || !Array.isArray(j.segments)) return { candidates: [], rejected: [], commercial: false, error: '模型回复不是有效的 JSON' };
    const out = [], rejected = [];
    const AUTO = req && req.autoConfidence > 0 ? req.autoConfidence : AUTO_CONFIDENCE;
    for (const s of j.segments.slice(0, 20)) {
      if (!s || typeof s !== 'object') continue;
      const num = (x) => (typeof x === 'number' || (typeof x === 'string' && /^\s*\d+\s*$/.test(x)) ? Math.round(+x) : NaN);
      let i0 = num(s.first), i1 = num(s.last);
      const why = (r) => rejected.push({ first: s.first, last: s.last, kind: s.kind, product: String(s.product || '').slice(0, 60), reason: r });
      if (!isFinite(i0) || !isFinite(i1)) { why('行号无效'); continue; }
      let q0 = s.first_quote, q1 = s.last_quote;
      if (i1 < i0) { [i0, i1] = [i1, i0]; [q0, q1] = [q1, q0]; }
      if (i0 < 0 || i1 >= lines.length) { why('行号越界'); continue; }
      // a line number the model invented is caught by its own quote
      if (!quoteNear(lines, i0, q0) || !quoteNear(lines, i1, q1)) { why('引用与字幕不符'); continue; }
      // only an explicit "sponsor" is an ad; any other word the model invents is treated as unsure (offered)
      const kind = s.kind === 'sponsor' || s.kind === 'self_promo' ? s.kind : 'unsure';
      if (kind === 'self_promo') { why('UP 主自荐'); continue; }
      const start = lines[i0].a, end = lines[i1].b;
      if (end - start < MIN_LEN) { why('过短'); continue; }
      if (dur > 0 && end - start > MAX_SHARE * dur) { why('超过半个视频'); continue; }
      let conf = Math.max(0, Math.min(1, +s.confidence || 0));
      // the model's word is the evidence: confident sponsor reads are skipped; unsure ones are offered
      const offerOnly = kind === 'unsure' || conf < AUTO || !!j.whole_video_commercial || end - start > MAX_AUTO_LEN;
      const product = String(s.product || '').replace(/\s+/g, ' ').slice(0, 60);
      out.push({
        start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, source: 'llm', sources: ['llm'],
        confidence: offerOnly ? Math.min(conf, 0.55) : Math.min(0.97, 0.6 + 0.4 * conf),
        offerOnly: offerOnly || undefined,
        reason: 'AI 字幕分析' + (product ? '：' + product : '') + (kind === 'unsure' ? '（不确定）' : '') + (j.whole_video_commercial ? '（整期是商业内容，只提示）' : ''),
        // uncertain = offered only because the model hedged (not because of the video-level or length rules):
        // these get a second, focused question (buildVerifyRequest)
        evidence: { llm: { lines: [i0, i1], kind, confidence: conf, product, uncertain: (kind === 'unsure' || conf < AUTO) && conf >= VERIFY_MIN_CONFIDENCE && !j.whole_video_commercial && end - start <= MAX_AUTO_LEN } },
      });
    }
    out.sort((a, b) => a.start - b.start);
    return { candidates: capAuto(out, dur), rejected, commercial: !!j.whole_video_commercial };
  }

  /**
   * Video-level caps over the final list (first answer, and again after the second question): more than MAX_AUTO_READS
   * auto-skips, or auto-skips plus the offers touching them covering more than MAX_AUTO_SHARE of the video, turn every
   * read into an offer. A capped list asks no second question. Mutates and returns `cands`.
   */
  function capAuto(cands, duration) {
    const auto = cands.filter((c) => !c.offerOnly);
    // offers that overlap or touch a skip would widen it in fusion: they count toward the covered time
    const touching = cands.filter((c) => c.offerOnly && auto.some((a) => c.start <= a.end + 1 && c.end >= a.start - 1));
    const spans = auto.concat(touching).sort((x, y) => x.start - y.start);
    let covered = 0, reach = -Infinity;
    for (const c of spans) { covered += Math.max(0, c.end - Math.max(c.start, reach)); reach = Math.max(reach, c.end); }
    if (auto.length > MAX_AUTO_READS || (duration > 0 && covered > MAX_AUTO_SHARE * duration)) {
      for (const c of cands) {
        if (!c.offerOnly) { c.offerOnly = true; c.confidence = Math.min(c.confidence, 0.55); c.reason += '（片段过多或过长，只提示）'; }
        if (c.evidence && c.evidence.llm) c.evidence.llm.uncertain = false;
      }
    }
    return cands;
  }

  /** Cache key part: the transcript's identity (length + sampled text) so a re-generated subtitle is re-judged. */
  function fingerprint(lines) {
    const L = toLines(lines);
    let h = 2166136261;
    const step = Math.max(1, Math.floor(L.length / 64));
    for (let i = 0; i < L.length; i += step) for (const ch of L[i].text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return L.length + ':' + h.toString(36);
  }

  const VERIFY_SYSTEM = [
    'You check one passage of a bilibili video transcript for an ad-skipping browser extension. Lines are "<n>|<m:ss>|<text>"; AI transcription errors are common.',
    'A first pass flagged lines as a POSSIBLE inserted sponsored segment. Decide whether it really is one: the uploader leaves the video\'s own content to promote a third party\'s product, service, app, game, shop or platform campaign as a paid placement (a segue into the product, praise of it, often a call to action, then back to the topic). A sponsor thank-you or reminder counts.',
    'It is NOT one when it is the video\'s own topic (even a product review or the game the video is about), the uploader\'s own channel / merch / course, a passing mention, or a joke about ads.',
    'If it is one, give its exact first line (the segue that starts steering toward the product) and last line (the last line about the promotion; the first sentence back on topic is content), which may differ from the flagged lines, with a few words quoted from each.',
    'Answer with JSON only: {"verdict":"sponsor"|"not_sponsor"|"unsure","first":<line n>,"last":<line n>,"first_quote":"…","last_quote":"…","confidence":<0..1>}',
  ].join('\n');
  const VERIFY_SCHEMA = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['sponsor', 'not_sponsor', 'unsure'] },
      first: { type: 'integer' }, last: { type: 'integer' },
      first_quote: { type: 'string' }, last_quote: { type: 'string' }, confidence: { type: 'number' },
    },
    required: ['verdict', 'first', 'last', 'first_quote', 'last_quote', 'confidence'],
    additionalProperties: false,
  };
  /** Second question about one uncertain read: the passage around it, with the original line numbers. */
  function buildVerifyRequest(req, cand, title) {
    const [f, l] = cand.evidence.llm.lines;
    const a = Math.max(0, f - VERIFY_CONTEXT), b = Math.min(req.lines.length - 1, l + VERIFY_CONTEXT);
    const rows = [];
    for (let k = a; k <= b; k++) rows.push(`${k}|${mmss(req.lines[k].a)}|${req.lines[k].text}`);
    const user = [`Title: ${clean(title).slice(0, 200)}`, `Flagged lines: ${f}–${l}` + (cand.evidence.llm.product ? ` (product: ${clean(cand.evidence.llm.product).slice(0, 60)})` : ''), `Passage (lines ${a}–${b}):`].join('\n') + '\n' + rows.join('\n');
    return { system: VERIFY_SYSTEM, user, schema: VERIFY_SCHEMA, range: [a, b], cand };
  }
  /**
   * The second answer → a replacement candidate (auto-skip when confirmed with confidence ≥ AUTO_CONFIDENCE), null when
   * it says not an ad, or the original offer when unsure / invalid.
   */
  function parseVerifyReply(reply, vreq, req) {
    const j = extractJson(reply), c0 = vreq.cand;
    if (!j || typeof j.verdict !== 'string') return c0;
    if (j.verdict === 'not_sponsor') return null;
    if (j.verdict !== 'sponsor') return c0;
    const r = parseReply({ segments: [{ first: j.first, last: j.last, kind: 'sponsor', product: c0.evidence.llm.product, confidence: j.confidence, first_quote: j.first_quote, last_quote: j.last_quote }], whole_video_commercial: false }, req);
    const c = r.candidates[0];
    // the refined edges must stay near the flagged read (the passage is all the model saw)
    if (!c || c.end <= c0.start - 60 || c.start >= c0.end + 60 || c.evidence.llm.lines[0] < vreq.range[0] || c.evidence.llm.lines[1] > vreq.range[1]) return c0;
    c.evidence.llm.verified = true;
    c.reason = c.reason.replace('AI 字幕分析', 'AI 字幕分析（复核）');
    return c;
  }

  BAS.detectLlm = { autoConfidenceFor, capAuto, buildRequest, parseReply, buildVerifyRequest, parseVerifyReply, VERIFY_SYSTEM, VERIFY_SCHEMA, extractJson, fingerprint, toLines, SYSTEM, SCHEMA, PROMPT_VERSION, CONST: { MAX_LINES, MAX_CHARS, MIN_LEN, MAX_SHARE, AUTO_CONFIDENCE, MAX_AUTO_LEN, MAX_AUTO_SHARE, MAX_AUTO_READS, VERIFY_CONTEXT, MAX_VERIFY } };
})();
