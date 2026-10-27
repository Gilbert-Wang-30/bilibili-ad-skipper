/* Bilibili Ad Skipper — sponsor reads found in the video's AI subtitles (what the uploader says).
 *
 * No AI and nothing sent anywhere: every subtitle line gets a score from a table of phrase weights (27-subtitle-model.js,
 * counted from thousands of crowd-labelled videos — how much more often a phrase is said inside a marked ad than outside
 * one), plus a few things about the line itself (where it sits in the video, how fast it is read, whether it repeats a
 * name that is said nowhere else in the video — the product). Boosted decision trees (also plain numbers in
 * 27-subtitle-model.js) then re-score each line from how those scores run around it and across the video and, when
 * given, from what the danmaku and the heat curve say at that moment (29-media-features.js). A two-state segmenter picks
 * the stretches whose lines add up to a read, opening and closing on the sentences reads usually open and close with;
 * each stretch is scored once more as a whole (how strong, how long, how it stands out from the talk around it) and
 * skipped, offered or dropped by that score. Subtitle lines are sentence-timed, so both edges land on a sentence
 * boundary. Pure; no DOM / chrome.*.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectSubtitles) return;

  const WINDOW = 7;           // s of neighbouring lines whose phrases count as the line's context
  const BURST_NEAR = 60;      // s: a name said ≥ 3 times this close …
  const BURST_FAR = 150;      // … and nowhere further than this from the line is a local name (a product, a brand)
  const NOVEL_FAR = 120;      // s: a phrase never said further than this from the line is new to the video
  const MIN_LEN = 8;
  const MAX_LEN = 420;
  const READ_CTX = 30;        // s on each side of a stretch whose lines are its surroundings (read scorer)
  // work bounds for files that are not sentence-timed speech (a hand-made subtitle with a line every few ms, or
  // paragraphs): real AI subtitles have at most ~20 lines in 7 s and ~80 characters a line, so neither binds there
  const MAX_NEAR = 24;        // neighbouring lines per side that count as a line's context
  const MAX_CHARS = 80;       // characters of a line that are scored

  // ordinary words that are never a product name, however often they repeat locally
  const STOP = new Set(['我们', '大家', '一个', '这个', '那个', '就是', '可以', '然后', '因为', '所以', '而且', '还是', '如果', '时候',
    '自己', '没有', '什么', '真的', '非常', '这样', '他们', '你们', '一下', '一些', '现在', '已经', '觉得', '感觉', '的话', '一样',
    '不是', '这么', '起来', '出来', '还有', '其实', '之后', '只要', '直接', '不会', '以及', '一定', '这种', '比较', '可能', '时间',
    '问题', '东西', '需要', '开始', '知道', '看到', '但是', '那么', '很多', '一直', '今天', '之前', '以后', '特别', '所有', '一起']);
  // characters that make a 2-char n-gram a phrase fragment rather than a name (出一, 一点, 的时 …)
  const FUNC_RE = /[的了是在我你他她它这那个不就也都有人们吗呢啊吧哦嘛呀一和与及或很太还又再才把被让给对从到为得着过么之其些点上下来去出说要会能想看]/;

  /** Lower case, half-width, digits → 0, letters / digits / CJK only. */
  function norm(t) {
    return String(t == null ? '' : t)
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase().replace(/[0-9]/g, '0').replace(/[^一-鿿a-z0]/g, '');
  }
  /** Character n-grams of a normalised line, 1..3, plus its first and last two characters marked as such. */
  function lineGrams(n) {
    const out = new Set();
    for (let len = 1; len <= 3; len++) for (let i = 0; i + len <= n.length; i++) out.add(n.slice(i, i + len));
    if (n.length >= 2) { out.add('^' + n.slice(0, 2)); out.add(n.slice(-2) + '$'); }
    return out;
  }
  /** Candidate names in a line: 2–4-grams that are not function-word fragments. */
  function nameGrams(n) {
    const out = new Set();
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= n.length; i++) {
        const g = n.slice(i, i + len);
        if (STOP.has(g) || /0/.test(g)) continue;
        if (len === 2 && FUNC_RE.test(g)) continue;
        if (len >= 3 && FUNC_RE.test(g[0]) && FUNC_RE.test(g[len - 1])) continue;
        out.add(g);
      }
    }
    return out;
  }
  const bin = (x, edges) => { let i = 0; while (i < edges.length && x >= edges[i]) i++; return i; };

  /**
   * Subtitle body → time-sorted lines with everything the scorer needs (reusable across calls).
   * Each line: {a, b, text, n, own:Set, ctx:[2-grams], names:Set, burst, novel, cps, gap, pos}.
   */
  function prepare(lines, duration) {
    if (Array.isArray(lines) && lines.prepared) return lines;
    const L = [];
    for (const r of Array.isArray(lines) ? lines : []) {
      const a = +(r && (r.from != null ? r.from : r[0])), b = +(r && (r.to != null ? r.to : r[1]));
      const text = r && (r.content != null ? r.content : r[2]);
      if (!isFinite(a) || !isFinite(b) || b < a || typeof text !== 'string') continue;
      const n = norm(text).slice(0, MAX_CHARS), own = lineGrams(n);
      const ctx = []; for (const g of own) if (g.length === 2) ctx.push(g);   // what neighbours hear of it: plain 2-grams
      L.push({ a, b, text, n, own, ctx, names: nameGrams(n) });
    }
    L.sort((x, y) => x.a - y.a);
    const dur = duration > 0 ? duration : (L.length ? L[L.length - 1].b : 0);
    // where every name is said: the midpoints of its lines, sorted (a line's own midpoint is among them)
    const at = new Map();
    for (const l of L) { const m = (l.a + l.b) / 2; for (const g of l.names) { let x = at.get(g); if (!x) at.set(g, x = []); x.push(m); } }
    for (const x of at.values()) x.sort((p, q) => p - q);
    // how many of the sorted midpoints ms lie within r of t (two binary searches: a repeated line costs log, not a scan)
    const within = (ms, t, r) => {
      let lo = 0, hi = ms.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (t - ms[k] > r) lo = k + 1; else hi = k; }
      const first = lo;
      hi = ms.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (ms[k] - t <= r) lo = k + 1; else hi = k; }
      return lo - first;
    };
    for (let i = 0; i < L.length; i++) {
      const l = L[i], t = (l.a + l.b) / 2;
      let burst = 0, novel = 0;
      for (const g of l.names) {
        const ms = at.get(g), before = t - ms[0], after = ms[ms.length - 1] - t;
        if (before <= NOVEL_FAR && after <= NOVEL_FAR) novel++;
        if (before <= BURST_FAR && after <= BURST_FAR && within(ms, t, BURST_NEAR) >= 3) burst++;
      }
      l.burst = burst;
      l.novel = l.names.size ? novel / l.names.size : 0;
      l.cps = l.n.length / Math.max(0.3, l.b - l.a);
      l.gap = i ? Math.max(0, l.a - L[i - 1].b) : 99;
      l.pos = dur > 0 ? Math.min(0.999, Math.max(0, t / dur)) : 0.5;
    }
    L.prepared = true;
    L.duration = dur;
    return L;
  }

  /** Feature names of line i (the phrase table is keyed by these). */
  function features(L, i) {
    const l = L[i];
    const f = [];
    for (const g of l.own) f.push('o:' + g);
    // what is said just before and just after the line, separately: a read's last sentence has ad talk only before it
    const before = new Set(), after = new Set();
    const j0 = Math.max(0, i - MAX_NEAR), j1 = Math.min(L.length - 1, i + MAX_NEAR);
    for (let j = i - 1; j >= j0 && l.a - L[j].b <= WINDOW; j--) for (const g of L[j].ctx) before.add(g);
    for (let j = i + 1; j <= j1 && L[j].a - l.b <= WINDOW; j++) for (const g of L[j].ctx) after.add(g);
    for (const g of before) f.push('b:' + g);
    for (const g of after) f.push('f:' + g);
    let wburst = 0;
    for (let j = i - 1; j >= j0 && l.a - L[j].b <= WINDOW; j--) wburst += L[j].burst;
    for (let j = i + 1; j <= j1 && L[j].a - l.b <= WINDOW; j++) wburst += L[j].burst;
    f.push('pos:' + Math.floor(l.pos * 10), 'cps:' + bin(l.cps, [3, 4, 5, 6, 7, 8]), 'gap:' + bin(l.gap, [0.15, 0.6, 1.5, 4]),
      'burst:' + Math.min(3, l.burst), 'wburst:' + bin(wburst, [1, 3, 6, 10]), 'novel:' + bin(l.novel, [0.01, 0.34, 0.67, 0.99]),
      'len:' + bin(l.n.length, [4, 8, 13, 19]));
    return f;
  }

  const model = () => BAS.subtitleModel || null;
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const pick = (x, d) => (x != null ? x : d);

  /** Line i's features, computed once per prepared transcript. */
  const featuresOf = (L, i) => L[i].F || (L[i].F = features(L, i));
  /** Sum of a table's weights over line i's features, leaving out those whose prefix is listed in `drop` ('b:', 'f:', 'b:f:'). */
  function tableScore(L, i, T, drop) {
    let s = T.bias;
    const w = T.w;
    for (const k of featuresOf(L, i)) { if (drop && k[1] === ':' && drop.includes(k.slice(0, 2))) continue; const x = w[k]; if (x) s += x; }
    return s;
  }
  /** Per-line ad log-odds from the phrase table. */
  function lineScores(L, M) {
    const out = new Float64Array(L.length);
    for (let i = 0; i < L.length; i++) out[i] = tableScore(L, i, M);
    return out;
  }

  /** Log-odds of row `off` of a flat feature array from boosted trees {base, trees: [{f, t, l, r, v}]} (f < 0: a leaf). */
  function predictTrees(T, x, off) {
    let s = T.base;
    for (const t of T.trees) {
      let k = 0;
      while (t.f[k] >= 0) k = x[off + t.f[k]] <= t.t[k] ? t.l[k] : t.r[k];
      s += t.v[k];
    }
    return s;
  }
  const STACK_D = 35;
  /**
   * Second stage, per line: how the phrase-table scores S run around the line (the lines next to it, the talk in the
   * 10 / 30 / 60 / 90 s around it) and across the whole video (how the line ranks, how strong the video's best
   * stretch is), where the line sits, and the edge tables' view of it. Float32Array n × (STACK_D + extraD);
   * extra(i, out, offset) may fill extraD more columns (danmaku / heat).
   */
  function stackFeatures(L, S, M, extraD = 0, extra = null) {
    const n = L.length, D = STACK_D + extraD, P = M.params, out = new Float32Array(n * D);
    if (!n) return out;
    const e = new Float64Array(n), mid = new Float64Array(n);
    for (let i = 0; i < n; i++) { e[i] = S[i] - P.prior; mid[i] = (L[i].a + L[i].b) / 2; }
    const sorted = Float64Array.from(e).sort();
    let sum = 0, sq = 0, high = 0;
    for (let i = 0; i < n; i++) { sum += e[i]; sq += e[i] * e[i]; if (e[i] > 3) high++; }
    const mean = sum / n, sd = Math.sqrt(Math.max(1e-6, sq / n - mean * mean));
    const vmax = sorted[n - 1], p95 = sorted[Math.min(n - 1, Math.floor(0.95 * n))];
    const dur = L.duration > 0 ? L.duration : L[n - 1].b;
    // distance to the nearest other strong line, both ways
    const nearHigh = new Float64Array(n).fill(900);
    let lastHigh = -Infinity;
    // (≥ 0 also when lines overlap and a midpoint runs backwards)
    for (let i = 0; i < n; i++) { nearHigh[i] = Math.min(900, Math.max(0, mid[i] - lastHigh)); if (e[i] > 3) lastHigh = mid[i]; }
    lastHigh = Infinity;
    for (let i = n - 1; i >= 0; i--) { nearHigh[i] = Math.min(nearHigh[i], Math.max(0, lastHigh - mid[i])); if (e[i] > 3) lastHigh = mid[i]; }
    const at = (j) => (j >= 0 && j < n ? e[j] : -8);
    // mean, max and share > 0 of e over the lines whose midpoint is within [t + lo, t + hi] of line i's
    const win = (i, lo, hi) => {
      const t = mid[i];
      let s = 0, c = 0, mx = -8, pos = 0;
      const add = (j) => { s += e[j]; c++; if (e[j] > mx) mx = e[j]; if (e[j] > 0) pos++; };
      for (let j = i, k = 0; j >= 0 && k < 400; j--, k++) { const d = mid[j] - t; if (d < lo) break; if (d <= hi) add(j); }
      for (let j = i + 1, k = 0; j < n && k < 400; j++, k++) { const d = mid[j] - t; if (d > hi) break; if (d >= lo) add(j); }
      return c ? [s / c, mx, pos / c] : [-8, -8, 0];
    };
    const T = M.start && P.edgeBack >= 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], o = i * D;
      let lo = 0, hi = n;
      while (lo < hi) { const k = (lo + hi) >> 1; if (sorted[k] < e[i]) lo = k + 1; else hi = k; }
      const w10b = win(i, -10, -1e-9), w10f = win(i, 1e-9, 10), w30 = win(i, -30, 30), w60 = win(i, -60, 60), w90 = win(i, -90, 90);
      out[o] = e[i];
      out[o + 1] = at(i - 3); out[o + 2] = at(i - 2); out[o + 3] = at(i - 1); out[o + 4] = at(i + 1); out[o + 5] = at(i + 2); out[o + 6] = at(i + 3);
      out[o + 7] = w10b[0]; out[o + 8] = w10f[0]; out[o + 9] = w30[0]; out[o + 10] = w60[0];
      out[o + 11] = w30[1]; out[o + 12] = w90[1]; out[o + 13] = w30[2];
      out[o + 14] = lo / n; out[o + 15] = vmax; out[o + 16] = mean; out[o + 17] = p95; out[o + 18] = (e[i] - mean) / sd;
      out[o + 19] = Math.log1p(nearHigh[i]);
      out[o + 20] = l.pos; out[o + 21] = Math.log(Math.max(1, dur)); out[o + 22] = Math.log1p(Math.max(0, l.a)); out[o + 23] = Math.log1p(Math.max(0, dur - l.b));
      out[o + 24] = l.cps; out[o + 25] = Math.min(30, l.gap); out[o + 26] = i + 1 < n ? Math.min(30, L[i + 1].gap) : 30; out[o + 27] = l.n.length;
      out[o + 28] = l.burst; out[o + 29] = l.novel; out[o + 30] = Math.log1p(high);
      out[o + 31] = T ? edgeScore(L, i, M.start, pick(P.sDrop, 'f:')) : 0;
      out[o + 32] = M.end && P.edgeBack >= 0 ? edgeScore(L, i, M.end, pick(P.eDrop, 'b:')) : 0;
      out[o + 33] = M.bstart ? boundaryLogP(L, i, M.bstart, 'start') : 0;
      out[o + 34] = M.bend ? boundaryLogP(L, i, M.bend, 'end') : 0;
      if (extra) extra(i, out, o + STACK_D);
    }
    return out;
  }
  /** Line log-odds after the second stage (trees T, by default the model's text-only `line` trees, over stackFeatures). */
  function stackScores(L, S, M, extraD = 0, extra = null, T = M.line) {
    const D = STACK_D + extraD, X = stackFeatures(L, S, M, extraD, extra), out = new Float64Array(L.length);
    for (let i = 0; i < L.length; i++) out[i] = predictTrees(T, X, i * D);
    return out;
  }
  /**
   * The line scores the segmenter uses: the phrase table, then the second stage — with the danmaku and the heat curve
   * (`lineM` trees) when they are given, else from the text alone (`line`).
   */
  function scoresOf(L, M, dur, settings, media) {
    const S0 = lineScores(L, M), MF = BAS.mediaFeatures;
    if (M.lineM && MF && media && (Array.isArray(media.danmaku) || media.heat)) {
      const X = media.index || MF.prepareMedia(media.danmaku || [], media.heat || null, dur, settings);
      return stackScores(L, S0, M, MF.CONST.MEDIA_D, (i, out, off) => MF.mediaAt(X, L[i].a, L[i].b, out, off), M.lineM);
    }
    return M.line ? stackScores(L, S0, M) : S0;
  }

  /**
   * Features of "a read starts (ends) at line i": the line's own n-grams and bins, the n-grams of the line just before
   * (after) it — the sentence a read is segued from (handed back to) — and the pause between the two.
   */
  function boundaryFeatures(L, i, which) {
    const f = [];
    for (const k of featuresOf(L, i)) if (!(k[1] === ':' && (k[0] === 'b' || k[0] === 'f'))) f.push(k);
    const j = which === 'start' ? i - 1 : i + 1, pre = which === 'start' ? 'p:' : 'n:';
    if (j >= 0 && j < L.length) { for (const g of L[j].own) if (g.length >= 2) f.push(pre + g); } else f.push(pre + 'none');
    const gap = which === 'start' ? L[i].gap : (i + 1 < L.length ? L[i + 1].gap : 99);
    f.push('bg:' + bin(gap, [0.15, 0.6, 1.5, 4]));
    return f;
  }
  // edge / boundary table scores, computed once per line and table
  const memoT = new WeakMap();
  function memo(T, key, L, k, fn) {
    let byKey = memoT.get(T); if (!byKey) memoT.set(T, byKey = new Map());
    let byL = byKey.get(key); if (!byL) byKey.set(key, byL = new WeakMap());
    let a = byL.get(L); if (!a) byL.set(L, a = new Float64Array(L.length).fill(NaN));
    if (a[k] !== a[k]) a[k] = fn();
    return a[k];
  }
  const edgeScore = (L, k, T, drop) => memo(T, drop, L, k, () => tableScore(L, k, T, drop));
  /** log P(a read starts / ends at line k) from a boundary table: a weak boundary costs a lot, a strong one gains little. */
  const boundaryLogP = (L, k, T, which) => memo(T, '@' + which, L, k, () => {
    let s = T.bias; for (const f of boundaryFeatures(L, k, which)) { const x = T.w[f]; if (x) s += x; }
    return s < -30 ? s : -Math.log1p(Math.exp(-s));
  });
  /** Best change point in s[0..m-1]: c maximising Σ from c of s − Σ before c of s + bonus[c] (c = 0 … m-1). */
  function changePoint(s, bonus) {
    const total = s.reduce((x, y) => x + y, 0);
    let best = 0, bestV = -Infinity, pre = 0;
    for (let c = 0; c < s.length; c++) {
      const v = total - 2 * pre + bonus[c];
      if (v > bestV) { bestV = v; best = c; }
      pre += s[c];
    }
    return best;
  }
  /**
   * Edges: around a stretch's first (last) line, the sentence that best separates "not yet (no longer) a read" from
   * "read" by the edge tables, plus (×sBeta / ×eBeta) how likely a boundary table finds a read to open (close) right
   * there. The start table sees the line alone (sDrop 'b:f:'), the end table the line and what comes after it
   * (eDrop 'b:'), so the read's own talk before an end does not pull the end into the content after it. Searched sBack s before /
   * sFwd s after the first line and eFwd s before / eBack s after the last. Returns [i0, i1].
   */
  function refine(L, M, i0, i1) {
    const P = M.params;
    if (M.start && P.edgeBack >= 0) {
      const back = pick(P.sBack, P.edgeBack), fwd = pick(P.sFwd, P.edgeFwd), drop = pick(P.sDrop, 'f:'), beta = M.bstart ? pick(P.sBeta, 0) : 0;
      const t0 = L[i0].a;
      let a = i0, b = i0;
      while (a > 0 && t0 - L[a - 1].a <= back) a--;
      while (b < i1 && L[b + 1].a - t0 <= fwd) b++;
      const s = [], bonus = [];
      for (let k = a; k <= b; k++) {
        s.push(edgeScore(L, k, M.start, drop));
        bonus.push(beta ? beta * boundaryLogP(L, k, M.bstart, 'start') : 0);
      }
      i0 = a + changePoint(s, bonus);
    }
    if (M.end && P.edgeBack >= 0) {
      const back = pick(P.eBack, P.edgeBack), fwd = pick(P.eFwd, P.edgeFwd), drop = pick(P.eDrop, 'b:'), beta = M.bend ? pick(P.eBeta, 0) : 0;
      const t1 = L[i1].b;
      let a = i1, b = i1;
      while (a > i0 && t1 - L[a - 1].b <= fwd) a--;
      while (b < L.length - 1 && L[b + 1].b - t1 <= back) b++;
      // the same search run backwards: the last line of the read is the first, from the end, of the "read" side
      const s = [], bonus = [];
      for (let k = b; k >= a; k--) {
        s.push(edgeScore(L, k, M.end, drop));
        bonus.push(beta ? beta * boundaryLogP(L, k, M.bend, 'end') : 0);
      }
      i1 = Math.max(i0, b - changePoint(s, bonus));
    }
    return [i0, i1];
  }

  /**
   * Two-state segmentation (content / read) maximising Σ over read lines of (score − prior)·α − shift minus a fixed cost
   * per read; a pause longer than maxGap ends a read. The edges are placed afterwards (refine). Returns [[i0, i1], …].
   */
  function segment(L, S, P) {
    const n = L.length;
    if (!n) return [];
    const em = new Float64Array(n);
    for (let i = 0; i < n; i++) em[i] = P.alpha * (S[i] - P.prior) - P.shift;
    // best[i][state], back pointers
    const c = new Float64Array(n), r = new Float64Array(n);
    const bc = new Uint8Array(n), br = new Uint8Array(n);
    c[0] = 0; r[0] = em[0] - P.enter;
    for (let i = 1; i < n; i++) {
      const gapBreak = L[i].a - L[i - 1].b > P.maxGap;          // a long silence ends a read
      const fromC = c[i - 1], fromR = r[i - 1];
      // content at i: from content, or a read ended at i-1
      if (fromC >= fromR) { c[i] = fromC; bc[i] = 0; } else { c[i] = fromR; bc[i] = 1; }
      // read at i: continue (not across a long silence) or start here
      const cont = gapBreak ? -Infinity : fromR, start = fromC - P.enter;
      if (cont >= start) { r[i] = cont + em[i]; br[i] = 1; } else { r[i] = start + em[i]; br[i] = 0; }
    }
    const spans = [];
    let st = r[n - 1] > c[n - 1] ? 1 : 0, end = st ? n - 1 : -1;
    for (let i = n - 1; i >= 0; i--) {
      if (st === 1) {
        const prev = br[i];
        if (prev === 0) { spans.push([i, end]); st = 0; }
        else st = 1;
      } else {
        const prev = bc[i];
        if (prev === 1) { st = 1; end = i - 1; }
      }
    }
    return spans.reverse().filter(([i0, i1]) => i1 >= i0);
  }
  const clipE = (e) => Math.max(-10, Math.min(10, e));
  /**
   * Whole-read features → probability that the stretch is a sponsor read. Besides how strong and long the stretch is,
   * how ad-like the talk just before and after it is (a read stands out from its surroundings; a fragment of a longer
   * read or a talky stretch does not), and the most ad-like 5-line passage elsewhere in the video (most videos carry
   * one read, so a second, weaker stretch next to a clear read elsewhere is more likely ordinary talk).
   */
  function readFeatures(L, S, P, i0, i1) {
    let sum = 0, max = -Infinity, hi = 0, burst = 0;
    for (let k = i0; k <= i1; k++) { const e = S[k] - P.prior; sum += e; if (e > max) max = e; if (e > 2) hi++; burst += L[k].burst; }
    const nl = i1 - i0 + 1, len = L[i1].b - L[i0].a;
    let cb = 0, nb = 0, ca = 0, na = 0;
    for (let k = i0 - 1; k >= 0 && L[i0].a - L[k].b <= READ_CTX; k--) { cb += clipE(S[k] - P.prior); nb++; }
    for (let k = i1 + 1; k < L.length && L[k].a - L[i1].b <= READ_CTX; k++) { ca += clipE(S[k] - P.prior); na++; }
    const lo = L[i0].a - READ_CTX, hiT = L[i1].b + READ_CTX;
    let elsewhere = -3, run = 0, win = 0;
    for (let k = 0; k < L.length; k++) {
      const m = (L[k].a + L[k].b) / 2;
      if (m >= lo && m <= hiT) { run = 0; win = 0; continue; }
      win += clipE(S[k] - P.prior); run++;
      if (run > 5) { win -= clipE(S[k - 5] - P.prior); run = 5; }
      if (run === 5 && win / 5 > elsewhere) elsewhere = win / 5;
    }
    return {
      mean: sum / nl, sum: sum / 10, max, hi: Math.min(10, hi) / 10, hiShare: hi / nl, burst: Math.min(20, burst) / 10,
      lenLog: Math.log(Math.max(1, len)), short: len < 20 ? 1 : 0, long: len > 180 ? 1 : 0,
      pos: (L[i0].a + L[i1].b) / 2 / Math.max(1, L.duration), early: L[i0].a < 15 ? 1 : 0,
      before: nb ? cb / nb : -3, after: na ? ca / na : -3, nLog: Math.log(nl), elsewhere,
    };
  }
  function readProbability(M, x) {
    let s = M.seg.bias;
    for (const k in M.seg.w) s += M.seg.w[k] * (x[k] || 0);
    return sigmoid(s);
  }

  /**
   * @param {Array<{from:number, to:number, content:string}>} lines  subtitle body (bilibili subtitle JSON .body)
   * @param {number} duration
   * @param {object} [settings]
   * @param {{danmaku?: object[], heat?: object}} [media]  the video's danmaku ([{t, text}]) and parsed heat curve, if known
   * @returns {{candidates: object[], rejected: object[], lines: number}}
   */
  function detectSubtitles(lines, duration, settings, media) {
    const M = model();
    const L = prepare(lines, duration);
    if (!L.length || !M) return { candidates: [], rejected: [], lines: L.length };
    const dur = duration > 0 ? duration : L.duration;
    const P = M.params;
    const S = scoresOf(L, M, dur, settings, media);
    const out = [], rejected = [];
    for (const span of segment(L, S, P)) {
      const [i0, i1] = refine(L, M, span[0], span[1]);
      const start = L[i0].a, end = Math.min(dur || Infinity, L[i1].b), len = end - start;
      const x = readFeatures(L, S, P, i0, i1);
      const p = readProbability(M, x);
      const item = { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, p, i0, i1 };
      if (len < MIN_LEN || len > MAX_LEN || p < P.offer) { rejected.push(item); continue; }
      const auto = p >= P.auto;
      const confidence = auto ? Math.min(0.95, 0.75 + 0.2 * (p - P.auto) / Math.max(1e-6, 1 - P.auto)) : 0.5;
      out.push({
        start: item.start, end: item.end, source: 'subtitle', sources: ['subtitle'], confidence,
        offerOnly: !auto || undefined,
        reason: `字幕：口播（${Math.round(p * 100)}%）`,
        evidence: { subtitle: { p: Math.round(p * 1000) / 1000, lines: i1 - i0 + 1 } },
      });
    }
    // A shopping video (好物推荐, a sale guide) talks like a read from start to end: offer, never auto-skip, there.
    const covered = out.filter((c) => !c.offerOnly).reduce((s, c) => s + (c.end - c.start), 0);
    if (out.filter((c) => !c.offerOnly).length > P.maxReads || (dur > 0 && covered > P.maxShare * dur)) {
      for (const c of out) { c.offerOnly = true; c.confidence = Math.min(c.confidence, 0.5); c.reason += '（整期像带货视频，只提示）'; }
    }
    for (const c of out) if (!c.offerOnly) delete c.offerOnly;
    return { candidates: out, rejected, lines: L.length };
  }

  /**
   * Skip button: the read playing at t — one the detector found or offered, or the weaker stretch around t now that the
   * viewer confirmed there is an ad. @returns {{end:number, start:number, reason:string, detected:boolean}|null}
   */
  const lastRun = new WeakMap();   // prepared transcript → {M, duration, media, r}: a press does not rescore every line
  function readEndAt(lines, t, duration, media) {
    const L = prepare(lines, duration);
    if (!L.length || !isFinite(t)) return null;
    let run = lastRun.get(L);
    if (!run || run.M !== model() || run.duration !== duration || run.media !== media) lastRun.set(L, run = { M: model(), duration, media, r: detectSubtitles(L, duration, undefined, media) });
    const r = run.r;
    const c = r.candidates.find((x) => t >= x.start - 3 && t < x.end - 2);
    if (c) return { end: c.end, start: c.start, reason: c.reason, detected: !c.offerOnly };
    const w = r.rejected.find((x) => t >= x.start - 3 && t < x.end - 2 && x.end - x.start >= 6 && x.p >= 0.15);
    if (w) return { end: w.end, start: w.start, reason: `字幕：可能的口播（${Math.round(w.p * 100)}%）`, detected: false };
    return null;
  }

  detectSubtitles.norm = norm;
  detectSubtitles.prepare = prepare;
  detectSubtitles.features = features;
  detectSubtitles.boundaryFeatures = boundaryFeatures;
  detectSubtitles.lineScores = lineScores;
  detectSubtitles.stackFeatures = stackFeatures;
  detectSubtitles.stackScores = stackScores;
  detectSubtitles.predictTrees = predictTrees;
  detectSubtitles.segment = segment;
  detectSubtitles.refine = refine;
  detectSubtitles.tableScore = tableScore;
  detectSubtitles.readFeatures = readFeatures;
  detectSubtitles.readProbability = readProbability;
  detectSubtitles.readEndAt = readEndAt;
  detectSubtitles.CONST = { WINDOW, BURST_NEAR, BURST_FAR, NOVEL_FAR, MIN_LEN, MAX_LEN, READ_CTX, MAX_NEAR, MAX_CHARS, STACK_D };
  BAS.detectSubtitles = detectSubtitles;
})();
