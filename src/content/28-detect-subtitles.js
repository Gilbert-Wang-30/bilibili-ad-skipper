/* Bilibili Ad Skipper — sponsor reads found in the video's AI subtitles (what the uploader says).
 *
 * An ad read ends in a call to action that ordinary content almost never says: 链接 / 置顶 / 下单 / 领券 / 运费险 / 保价 …
 * On 76 crowd-labelled videos (32k subtitle lines, 2026-10) the strong phrases below appeared inside ads in 15–60
 * videos each and in the content of none. Around those anchors the ad is grown line by line: lines that carry ad
 * vocabulary, and lines that repeat the advertised product's name — a term said near the anchors and nowhere else
 * in the video (a brand, a model, a game title), which is what finds the start of a read that opens with a story segue.
 * Subtitle lines are sentence-timed, so both edges land on a sentence boundary. Pure; no DOM / chrome.*.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectSubtitles) return;

  // weight 3: calls to action — in the content of at most 1 of the 76 videos; 2: shopping talk, in the content of ≤ 6;
  // 1: common words that only support a read found by the others
  const LEXICON = [
    [3, ['链接', '置顶', '下单', '领券', '优惠券', '运费险', '质保', '保价', '大促', '旗舰店', '天猫', '双11', '双十一', '618', '金主',
      '立减', '活动价', '直降', '券后', '包邮', '新用户', '到手价', '推广位', '恰饭', '小黄车', '购物车', '优惠码', '下方卡片',
      '蓝链', '首单', '以旧换新', '国补', '国家补贴', '七天无理由', '价保']],
    [2, ['评论区', '优惠', '这款', '划算', '有需要', '点击', '推广', '性价比', '专属', '入手', '京东', '淘宝', '拼多多', '补贴', '福利',
      '限时', '原价', '赞助', '种草', '同款', '神器', '售后']],
    [1, ['品牌', '产品', '体验', '价格', '推荐', '购买', '搜索', '注册', '买', '用上', '材质', '设计', '续航', '功能', '款', '广告',
      '官方', '活动', '平台', '下载', '折扣']],
  ];
  const EN_LEXICON = [
    [3, [/\blink (is )?in the (description|comments?)\b/, /\bpinned comment\b/, /\b(promo|discount|coupon) code\b/, /\bsponsor(ed|s)?\b/,
      /\bthis video is brought to you\b/, /\buse (my )?code\b/]],
    [2, [/\bdiscount\b/, /\bcoupon\b/, /\bdeal\b/, /\bcheck (it|them) out\b/, /\brecommend\b/, /\blimited[- ]time\b/, /\bofficial store\b/]],
    [1, [/\bprice\b/, /\bbrand\b/, /\bproduct\b/, /\byuan\b/, /\bbuy\b/]],
  ];
  // a read announced as one ("本期的推广位是…", "本期视频由…赞助") starts there: nothing before it is grown into the read
  const OPENER_RE = /推广位|本期(视频|节目|内容)?(由|的推广|推广|的赞助|赞助)|恰个?饭|金主|感谢.{0,12}(赞助|支持本期)|sponsored by|brought to you by/i;
  // lines a read typically opens with, right before the product appears
  const SEGUE_RE = /说到|说起|提到|话说|对了|不过在|相比|最近|今天的推广|本期(视频|节目)?(由|的推广)|感谢.{0,12}(赞助|支持)|speaking of|before we/i;
  // ordinary words that are never a product name, however often they repeat locally
  const STOP = new Set(['我们', '大家', '一个', '这个', '那个', '就是', '可以', '然后', '因为', '所以', '而且', '还是', '如果', '时候',
    '自己', '没有', '什么', '真的', '非常', '这样', '他们', '你们', '一下', '一些', '现在', '已经', '觉得', '感觉', '的话', '我们的',
    '的时候', '一样', '不是', '这么', '起来', '出来', '还有', '其实', '之后', '只要', '直接', '不会', '以及', '一定', '这种', '比较',
    '使用', '部分', '可能', '时间', '问题', '东西', '需要', '开始', '知道', '告诉', '看到', '但是', '那么', '很多', '一直', '今天',
    '之前', '以后', '特别', '能够', '所有', '一起', '这次', '每天', '同时', '包括', '目前', '应该', '通过', '进行', '方面', '情况']);

  const MAX_GAP = 20;        // s between ad-ish lines of one read (product description runs between them)
  const END_GAP = 6;         // s: after the last call to action, only lines this close extend the read
  const SEED_SPAN = 90;      // s: calls to action this close together belong to one read
  const MAX_GROW_BACK = 150; // s before the first call to action the start may move to
  const MIN_LEN = 12;
  const MAX_READS = 3;        // more reads than this in one video: a shopping video, not sponsor reads
  const SHOPPING_SHARE = 0.35;
  const MAX_LEN = 300;

  const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, '').toLowerCase();
  const isLatin = (t) => /[a-z]{3,}/i.test(t) && !/[一-鿿]/.test(t);

  /** Ad vocabulary in one line: weighted score, strongest weight, matched terms (longest match wins a span). */
  function scoreLine(text) {
    const raw = String(text == null ? '' : text);
    let score = 0, top = 0;
    const terms = [];
    if (isLatin(raw)) {
      const low = raw.toLowerCase();
      for (const [w, list] of EN_LEXICON) for (const re of list) { const m = low.match(re); if (m) { score += w; top = Math.max(top, w); terms.push(m[0]); } }
      return { score, top, terms };
    }
    const s = norm(raw);
    const used = new Uint8Array(s.length);
    const all = [];
    for (const [w, list] of LEXICON) for (const term of list) all.push([w, term]);
    all.sort((a, b) => b[1].length - a[1].length);
    for (const [w, term] of all) {
      let i = s.indexOf(term);
      while (i >= 0) {
        let free = true;
        for (let k = i; k < i + term.length; k++) if (used[k]) { free = false; break; }
        if (free) {
          for (let k = i; k < i + term.length; k++) used[k] = 1;
          score += w; top = Math.max(top, w); terms.push(term);
        }
        i = s.indexOf(term, i + term.length);
      }
    }
    return { score, top, terms };
  }

  /** n-grams (2–4 chars, CJK/latin/digits only) of a line, as a set. */
  function grams(text) {
    const s = norm(text).replace(/[^一-鿿a-z0-9]/g, '');
    const out = new Set();
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= s.length; i++) { const g = s.slice(i, i + n); if (!STOP.has(g)) out.add(g); }
    return out;
  }

  // characters that make a 2-char n-gram a phrase fragment rather than a name (出一, 一点, 的时 …)
  const FUNC_RE = /[的了是在我你他她它这那个不就也都有人们吗呢啊吧哦嘛呀一和与及或很太还又再才把被让给对从到为得着过么么之其些点上下来去出说要会能想看]/;

  /**
   * The advertised product's name: n-grams said in ≥ 3 lines of the read's neighbourhood [a, b], at least once close
   * to the calls to action [c0, c1], at least once in a line with ad vocabulary ("这款…", "买…"), and nowhere else in
   * the video. The co-occurrence keeps out the topic words of the content just before a read (names, places, numbers),
   * which are just as local.
   * @returns {Set<string>}
   */
  function productTerms(L, a, b, c0, c1) {
    const inside = new Map(), near = new Set(), withAd = new Set(), outside = new Set();
    for (const l of L) {
      if (l.a >= a && l.b <= b) {
        for (const g of l.g) inside.set(g, (inside.get(g) || 0) + 1);
        if (l.b >= c0 - 40 && l.a <= c1 + 20) for (const g of l.g) near.add(g);
        if (l.score > 0) for (const g of l.g) withAd.add(g);
      } else for (const g of l.g) outside.add(g);
    }
    const out = new Map();
    for (const [g, n] of inside) {
      if (n < 3 || outside.has(g) || !near.has(g) || !withAd.has(g)) continue;
      if (/\d/.test(g) && !/^[a-z]+\d+[a-z]*$|^\d+[a-z]+$/.test(g)) continue;      // 20米, 了20, 500 — model names like z1 stay
      if (g.length === 2 && FUNC_RE.test(g)) continue;
      if (g.length === 3 && FUNC_RE.test(g[0]) && FUNC_RE.test(g[2])) continue;
      out.set(g, n);
    }
    // keep the longest form of a name (a 4-gram brand name also yields its 2- and 3-grams with the same count)
    for (const [g, n] of [...out]) for (const [h, m] of out) if (h !== g && h.length > g.length && h.includes(g) && m >= n - 1) { out.delete(g); break; }
    return new Set(out.keys());
  }

  /** Subtitle body → time-sorted lines with their ad vocabulary and n-grams (reusable across calls). */
  function prepare(lines) {
    if (Array.isArray(lines) && lines.prepared) return lines;
    const L = [];
    for (const r of Array.isArray(lines) ? lines : []) {
      const a = +(r && (r.from != null ? r.from : r[0])), b = +(r && (r.to != null ? r.to : r[1]));
      const text = r && (r.content != null ? r.content : r[2]);
      if (!isFinite(a) || !isFinite(b) || b < a || typeof text !== 'string') continue;
      L.push(Object.assign({ a, b, text, n: norm(text), g: grams(text) }, scoreLine(text)));
    }
    L.sort((x, y) => x.a - y.a);
    L.prepared = true;
    return L;
  }

  /**
   * @param {Array<{from:number, to:number, content:string}>} lines  subtitle body (bilibili subtitle JSON .body)
   * @param {number} duration
   * @param {object} [settings]
   * @returns {{candidates: object[], lines: number}}
   */
  function detectSubtitles(lines, duration, settings) {
    const dur = duration > 0 ? duration : Infinity;
    const L = Array.isArray(lines) && lines.prepared ? lines : prepare(lines);
    if (!L.length) return { candidates: [], rejected: [], lines: 0 };
    const STRONG = new Set(LEXICON[0][1]);
    const strongOf = (l) => (l.top >= 3 ? l.terms.filter((t) => STRONG.has(t) || isLatin(l.text)) : []);

    // seeds: runs of call-to-action lines (a weight-3 term) within SEED_SPAN of each other
    const seeds = [];
    for (let i = 0; i < L.length; i++) {
      if (L[i].top < 3) continue;
      const last = seeds[seeds.length - 1];
      if (last && L[i].a - L[last.i1].b <= SEED_SPAN) last.i1 = i;
      else seeds.push({ i0: i, i1: i });
    }

    const out = [], rejected = [];
    for (const sd of seeds) {
      const c0 = L[sd.i0].a, c1 = L[sd.i1].b;
      const product = productTerms(L, c0 - MAX_GROW_BACK - 30, c1 + 40, c0, c1);
      const hasProduct = (l) => { for (const g of product) if (l.n.includes(g)) return true; return false; };
      // grow over lines that carry ad vocabulary or the product's name while they keep coming (gap ≤ MAX_GAP)
      let i0 = sd.i0, i1 = sd.i1;
      let opener = -1;
      for (let k = sd.i0; k <= sd.i1; k++) if (OPENER_RE.test(L[k].text)) { opener = k; break; }
      for (let k = i0 - 1; opener < 0 && k >= 0 && c0 - L[k].a <= MAX_GROW_BACK; k--) {
        if (L[i0].a - L[k].b > MAX_GAP) break;
        if (L[k].score > 0 || hasProduct(L[k])) i0 = k;
        if (i0 === k && OPENER_RE.test(L[k].text)) break;
      }
      if (opener >= 0) i0 = Math.min(i0, opener);
      // the end is what a skip lands on: grow forward only over close lines with clear evidence
      for (let k = i1 + 1; k < L.length; k++) {
        if (L[k].a - L[i1].b > END_GAP) break;
        if (L[k].score >= 2 || hasProduct(L[k])) i1 = k;
      }
      if (i0 > 0 && SEGUE_RE.test(L[i0 - 1].text) && L[i0].a - L[i0 - 1].b < 3) i0--;

      let score = 0, nLines = 0;
      const strong = new Set(), terms = new Set();
      for (let k = i0; k <= i1; k++) {
        const l = L[k];
        if (l.score > 0 || hasProduct(l)) nLines++;
        score += Math.min(6, l.score);
        for (const t of l.terms) terms.add(t);
        for (const t of strongOf(l)) strong.add(t);
      }
      const start = L[i0].a, end = Math.min(dur, L[i1].b);
      const len = end - start;
      // one call to action in passing ("链接放评论区了") is not a read: it needs a second one, or a product talked about
      const enough = strong.size >= 2 ? (score >= 8 || product.size >= 1) && nLines >= 3 : score >= 8 && product.size >= 1 && nLines >= 5;
      if (!enough || len < MIN_LEN || len > MAX_LEN) { rejected.push({ start, end, strong: [...strong], score, nLines, product: [...product] }); continue; }
      // 76 crowd-labelled videos: 42 reads with two or more different calls to action, all inside marked ads; of 5 with
      // one, 1 was content (a joke about coupons) — those are offered with the button, not skipped
      const confidence = strong.size >= 2 ? Math.min(0.9, 0.75 + 0.03 * (strong.size - 2) + (product.size ? 0.03 : 0)) : 0.55;
      out.push({
        start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, source: 'subtitle', sources: ['subtitle'], confidence,
        reason: '字幕：' + [...strong].slice(0, 4).join('、') + (product.size ? ' · ' + [...product].slice(0, 2).join('、') : ''),
        evidence: { subtitle: { score: Math.round(score), anchors: [...strong].slice(0, 8), terms: terms.size, product: [...product].slice(0, 4) } },
      });
    }
    // two seeds of one read can grow into each other
    out.sort((x, y) => x.start - y.start);
    const merged = [];
    for (const c of out) {
      const p = merged[merged.length - 1];
      if (p && c.start <= p.end + 5) { p.end = Math.max(p.end, c.end); p.confidence = Math.max(p.confidence, c.confidence); }
      else merged.push(c);
    }
    const kept = merged.filter((c) => c.end - c.start <= MAX_LEN);
    // A shopping video (好物推荐, a sale guide) talks like a read from start to end: offer, never auto-skip, there.
    const covered = kept.reduce((x, c) => x + (c.end - c.start), 0);
    if (kept.length > MAX_READS || (isFinite(dur) && covered > SHOPPING_SHARE * dur)) {
      for (const c of kept) { c.offerOnly = true; c.confidence = Math.min(c.confidence, 0.5); c.reason += '（整期像带货视频，只提示）'; }
    }
    return { candidates: kept, rejected, lines: L.length };
  }

  /**
   * Skip button: the read playing at t — one the detector found, or one with too little evidence to skip on its own,
   * now that the viewer confirmed it. (Following the product talk forward without such a read was tried: on 39 presses
   * it landed within 3 s of the end only 28 % of the time and cut content 36 %, worse than a short blind step.)
   * @returns {{end:number, start:number, reason:string, detected:boolean}|null}
   */
  function readEndAt(lines, t, duration) {
    const L = prepare(lines);
    if (!L.length || !isFinite(t)) return null;
    const r = detectSubtitles(L, duration);
    const c = r.candidates.find((x) => t >= x.start - 3 && t < x.end - 2);
    if (c) return { end: c.end, start: c.start, reason: c.reason, detected: true };
    const w = r.rejected.find((x) => t >= x.start - 3 && t < x.end - 2 && x.end - x.start >= 6);
    if (w) return { end: Math.round(w.end * 10) / 10, start: Math.round(w.start * 10) / 10, reason: '字幕：' + (w.strong.length ? w.strong.slice(0, 3).join('、') : '产品介绍'), detected: false };
    return null;
  }

  detectSubtitles.scoreLine = scoreLine;
  detectSubtitles.prepare = prepare;
  detectSubtitles.readEndAt = readEndAt;
  detectSubtitles.CONST = { MAX_GAP, END_GAP, SEED_SPAN, MAX_GROW_BACK, MIN_LEN, MAX_LEN, MAX_READS, SHOPPING_SHARE };
  BAS.detectSubtitles = detectSubtitles;
})();
