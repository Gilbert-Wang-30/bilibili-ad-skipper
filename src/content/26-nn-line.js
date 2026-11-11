/* Bilibili Ad Skipper — the neural line model and its stretch decoder (used by 28-detect-subtitles.js when
 * 26-nn-model.js is present). No AI service: a small network trained offline (test/scratch/nn/, not shipped) whose
 * weights ship in 26-nn-model.js; everything here is plain arithmetic in this content script.
 *
 * Line model: each subtitle line's characters (a learned vector per character and per hashed character pair; mean +
 * max over the line) plus its timing and the 19 danmaku / heat columns (29-media-features.js mediaAt) → linear + GELU →
 * bidirectional GRU layers over the video's lines → a log-odds per line that the line belongs to a sponsor read.
 * Weights are int8 with one float scale per row. Decoder: hysteresis on the smoothed line probabilities (a read starts
 * where the smoothed probability reaches hi and extends while it stays ≥ lo), runs merged across short gaps, edges
 * trimmed to lines the model is sure of; each stretch scored by a logistic over its statistics, the danmaku / heat
 * inside and around it and the phrase-table scores.
 *   const net = BAS.nnLine.load(json); BAS.nnLine.scores(net, lines, duration, mediaRows) → Float32Array of logits
 *   (scoresAsync(…, pause): the same in stages, awaiting pause() between them)
 *   BAS.nnLine.stretches(p, lines, dec) → [[i0, i1], …]; features(…) → row; probability(row, scorer) → p
 */
(() => {
  const G = typeof globalThis !== 'undefined' ? globalThis : window;
  const BAS = (G.BAS = G.BAS || {});
  if (BAS.nnLine) return;

  const b64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  /** {shape:[r,c], q: base64 int8, s: base64 float32 per row} or {shape, f: base64 float32} → {r, c, w: Float32Array}. */
  function tensor(t) {
    const r = t.shape[0], c = t.shape.length > 1 ? t.shape[1] : 1, w = new Float32Array(r * c);
    if (t.f) { w.set(new Float32Array(b64(t.f).buffer)); return { r, c, w }; }
    const q = new Int8Array(b64(t.q).buffer), sc = new Float32Array(b64(t.s).buffer);
    for (let i = 0; i < r; i++) { const s = sc[i], o = i * c; for (let j = 0; j < c; j++) w[o + j] = q[o + j] * s; }
    return { r, c, w };
  }
  function load(m) {
    const T = {};
    for (const k of Object.keys(m.w)) T[k] = tensor(m.w[k]);
    const vocab = new Map();
    for (let i = 0; i < m.vocab.length; i++) vocab.set(m.vocab.charCodeAt(i), i + 2);
    return { cfg: m.cfg, T, vocab, mu: m.mu ? Float32Array.from(m.mu) : null, sd: m.sd ? Float32Array.from(m.sd) : null };
  }

  // erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7) for the exact GELU PyTorch uses
  const erf = (x) => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  };
  const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));
  const sig = (x) => 1 / (1 + Math.exp(-x));

  /** y[n × W.r] = x[n × W.c] · Wᵀ + b */
  function linear(x, n, W, b) {
    const R = W.r, Cc = W.c, w = W.w, y = new Float32Array(n * R);
    for (let i = 0; i < n; i++) {
      const xo = i * Cc, yo = i * R;
      for (let r = 0; r < R; r++) {
        let s = b ? b.w[r] : 0; const wo = r * Cc;
        for (let j = 0; j < Cc; j++) s += w[wo + j] * x[xo + j];
        y[yo + r] = s;
      }
    }
    return y;
  }
  /** One GRU direction over n steps; x[n × in] → writes h into out[n × outStride] at column off. */
  function gru(x, n, T, sfx, out, outStride, off, reverse) {
    const Wi = T['rnn.weight_ih_' + sfx], Wh = T['rnn.weight_hh_' + sfx], bi = T['rnn.bias_ih_' + sfx], bh = T['rnn.bias_hh_' + sfx];
    const H = Wh.c, gi = linear(x, n, Wi, bi), h = new Float32Array(H), gh = new Float32Array(3 * H), w = Wh.w;
    for (let k = 0; k < n; k++) {
      const t = reverse ? n - 1 - k : k, go = t * 3 * H;
      for (let r = 0; r < 3 * H; r++) { let s = bh.w[r]; const wo = r * H; for (let j = 0; j < H; j++) s += w[wo + j] * h[j]; gh[r] = s; }
      for (let j = 0; j < H; j++) {
        const rr = sig(gi[go + j] + gh[j]), z = sig(gi[go + H + j] + gh[H + j]);
        const nn = Math.tanh(gi[go + 2 * H + j] + rr * gh[2 * H + j]);
        h[j] = (1 - z) * nn + z * h[j];
        out[t * outStride + off + j] = h[j];
      }
    }
  }
  const hash2 = (u1, u2, bits) => ((Math.imul(u1, 0x9E3779B1 | 0) ^ Math.imul(u2, 0x85EBCA77 | 0)) >>> (32 - bits)) + 1;

  /** Logit per line, computed in stages: the generator pauses after the line vectors and after each GRU pass. */
  function* stages(net, lines, duration, media) {
    const { cfg, T, vocab } = net, n = lines.length, E = cfg.emb, Cmax = cfg.chars, bits = cfg.bits;
    if (!n) return new Float32Array(0);
    const dur = Math.max(1, duration || lines[n - 1].b), MD = net.mu ? net.mu.length : 0;
    const nx = 8 + MD + (cfg.s0 ? 1 : 0), D = 2 * E + nx, X = new Float32Array(n * D);
    const Eu = T['eu.weight'], Eg = T['eg.weight'];
    const sum = new Float32Array(E), mx = new Float32Array(E);
    for (let i = 0; i < n; i++) {
      const l = lines[i], s = String(l.n || ''), len = Math.min(Cmax, s.length), o = i * D;
      sum.fill(0); mx.fill(-1e4);
      for (let j = 0; j < len; j++) {
        const u = s.charCodeAt(j), ui = (vocab.get(u) || 1) * E;
        const gi = j < len - 1 ? hash2(u, s.charCodeAt(j + 1), bits) * E : 0;
        for (let k = 0; k < E; k++) { const e = Eu.w[ui + k] + (gi ? Eg.w[gi + k] : 0); sum[k] += e; if (e > mx[k]) mx[k] = e; }
      }
      for (let k = 0; k < E; k++) { X[o + k] = len ? sum[k] / len : 0; X[o + E + k] = len ? mx[k] : 0; }
      const a = l.a, b = l.b, d = Math.max(0.1, b - a), prev = i ? lines[i - 1].b : 0, nxt = i < n - 1 ? lines[i + 1].a : dur;
      const f = [Math.log1p(d), Math.log1p(Math.max(0, a - prev)), Math.log1p(Math.max(0, nxt - b)), a / dur, (dur - b) / dur,
        Math.min(len / d, 20) / 10, Math.log1p(len) / 4, Math.log1p(dur) / 8];
      for (let k = 0; k < 8; k++) X[o + 2 * E + k] = f[k];
      for (let k = 0; k < MD; k++) {
        const v = media ? media[i * MD + k] : NaN, m = v === v ? v : net.mu[k];   // NaN (not known): the training mean
        X[o + 2 * E + 8 + k] = Math.max(-5, Math.min(5, (m - net.mu[k]) / net.sd[k]));
      }
      if (cfg.s0) X[o + D - 1] = Math.max(-4, Math.min(4, (l.s0 || 0) / 4));
    }
    let h = linear(X, n, T['inp.weight'], T['inp.bias']);
    for (let i = 0; i < h.length; i++) h[i] = gelu(h[i]);
    const H = T['inp.weight'].r;
    yield;
    for (let layer = 0; layer < cfg.layers; layer++) {
      const out = new Float32Array(n * 2 * H);
      gru(h, n, T, 'l' + layer, out, 2 * H, 0, false);
      yield;
      gru(h, n, T, 'l' + layer + '_reverse', out, 2 * H, H, true);
      yield;
      h = out;
    }
    return linear(h, n, T['out.weight'], T['out.bias']);
  }
  /** Logit per line (in one go). */
  function scores(net, lines, duration, media) {
    const g = stages(net, lines, duration, media);
    let r;
    while (!(r = g.next()).done);
    return r.value;
  }
  /** The same, awaiting pause() between the stages (a long transcript as several short tasks instead of one long one). */
  async function scoresAsync(net, lines, duration, media, pause) {
    const g = stages(net, lines, duration, media);
    let r;
    while (!(r = g.next()).done) await pause();
    return r.value;
  }


  /** D: {hi, lo, w, gap, edge, keep?, eLo?}; p: Float64Array of line probabilities; lines: [{a, b}]. */
  function stretches(p, L, D, minLen = 8) {
    const n = p.length;
    if (!n) return [];
    const w = D.w | 0, q = new Float64Array(n);
    for (let i = 0; i < n; i++) {   // moving mean over 2w+1 lines, zeros beyond the ends (numpy convolve 'same')
      let s = 0; for (let j = i - w; j <= i + w; j++) if (j >= 0 && j < n) s += p[j];
      q[i] = s / (2 * w + 1);
    }
    const used = new Uint8Array(n), runs = [];
    for (let s = 0; s < n; s++) {
      if (q[s] < D.hi || used[s]) continue;
      let l = s, r = s;
      while (l > 0 && q[l - 1] >= D.lo) l--;
      while (r < n - 1 && q[r + 1] >= D.lo) r++;
      for (let k = l; k <= r; k++) used[k] = 1;
      runs.push([l, r]);
    }
    runs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const m = [];
    for (const [l, r] of runs) {
      if (m.length && L[l].a - L[m[m.length - 1][1]].b <= D.gap) m[m.length - 1][1] = Math.max(m[m.length - 1][1], r);
      else m.push([l, r]);
    }
    // edges on lines the model is sure of (p ≥ edge); where that keeps less than `keep` of the stretch, on lines it is
    // fairly sure of (p ≥ eLo) instead
    const out = [], adapt = D.eLo != null;
    for (const [l, r] of m) {
      const lo = adapt ? D.eLo : D.edge;
      let l1 = l, r1 = r;
      while (l1 < r1 && p[l1] < lo) l1++;
      while (r1 > l1 && p[r1] < lo) r1--;
      let l2 = l1, r2 = r1;
      if (adapt) {
        while (l2 < r2 && p[l2] < D.edge) l2++;
        while (r2 > l2 && p[r2] < D.edge) r2--;
        if (!(L[r2].b - L[l2].a >= Math.max(minLen, D.keep * (L[r1].b - L[l1].a)))) { l2 = l1; r2 = r1; }
      }
      if (L[r2].b - L[l2].a >= minLen) out.push([l2, r2]);
    }
    return out;
  }

  const lg = (x) => Math.log(x + 1e-4) - Math.log(1 - x + 1e-4);
  const median = (xs) => { const s = Array.from(xs).sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

  /**
   * The stretch's feature row (decode2.py feats): media is Float32Array n × MD (raw mediaAt columns) or null,
   * normalised here with mu / sd (no clipping, as in training); old = {ps, p0} (sigmoid of the stack / phrase-table
   * scores) or null when the scorer was fitted without them.
   */
  function features(p, L, dur, l, r, others, media, mu, sd, old) {
    const seg = p.subarray(l, r + 1), n = p.length, MD = mu ? mu.length : 0;
    let sum = 0, mx = -Infinity, mn = Infinity, f5 = 0, f9 = 0;
    for (const x of seg) { sum += x; if (x > mx) mx = x; if (x < mn) mn = x; if (x > 0.5) f5++; if (x > 0.9) f9++; }
    const k = seg.length, mean = sum / k, D = Math.max(1, dur), len = L[r].b - L[l].a;
    let cl = 0, ncl = 0, cr = 0, ncr = 0;
    for (let j = Math.max(0, l - 10); j < l; j++) { cl += p[j]; ncl++; }
    for (let j = r + 1; j < Math.min(n, r + 11); j++) { cr += p[j]; ncr++; }
    const f = [mean, mx, mn, median(seg), f5 / k, f9 / k, lg(mean), Math.log1p(len), Math.log1p(k), L[l].a / D, (D - L[r].b) / D,
      ncl ? cl / ncl : 0, ncr ? cr / ncr : 0, Math.log1p(D), others, len / D];
    if (old) {
      let sp = 0, mp = -Infinity, s0 = 0;
      for (let j = l; j <= r; j++) { sp += old.ps[j]; if (old.ps[j] > mp) mp = old.ps[j]; s0 += old.p0[j]; }
      f.push(sp / k, mp, s0 / k, lg(sp / k));
    }
    // danmaku / heat columns: mean inside, over the lines starting in the 30 s after, over those ending in the 30 s before
    const inside = new Float64Array(MD), after = new Float64Array(MD), before = new Float64Array(MD);
    let na = 0, nb = 0;
    const col = (i, c) => { const v = media ? media[i * MD + c] : NaN; return v === v ? (v - mu[c]) / sd[c] : 0; };
    for (let i = l; i <= r; i++) for (let c = 0; c < MD; c++) inside[c] += col(i, c) / k;
    for (let i = 0; i < n; i++) {
      if (L[i].a > L[r].b && L[i].a <= L[r].b + 30) { na++; for (let c = 0; c < MD; c++) after[c] += col(i, c); }
      if (L[i].b < L[l].a && L[i].b >= L[l].a - 30) { nb++; for (let c = 0; c < MD; c++) before[c] += col(i, c); }
    }
    for (let c = 0; c < MD; c++) f.push(inside[c]);
    for (let c = 0; c < MD; c++) f.push(na ? after[c] / na : 0);
    for (let c = 0; c < MD; c++) f.push(nb ? before[c] / nb : 0);
    return f;
  }

  /** P(stretch is a crowd-marked read) from the fitted logistic sc = {mu, sd, w} (w: one weight per column + bias). */
  function probability(f, sc) {
    let z = sc.w[sc.w.length - 1];
    for (let j = 0; j < f.length; j++) z += sc.w[j] * Math.max(-5, Math.min(5, (f[j] - sc.mu[j]) / sc.sd[j]));
    return 1 / (1 + Math.exp(-z));
  }

  BAS.nnLine = { load, scores, scoresAsync, stretches, features, probability };
})();
