/* Bilibili Ad Skipper — look-ahead media probe.
 *
 * The live MediaAnalyzer only sees frames that have already played. To judge a suspected ad BEFORE the viewer reaches
 * it, this module downloads the video's own DASH streams (lowest-bitrate audio, a 360p video track) for just the time
 * windows that matter, using the per-fragment byte index (sidx) that every bilibili stream carries, decodes them in the
 * page (decodeAudioData / WebCodecs) and turns them into compact per-moment features for 37-av-segment.js.
 *
 *   BAS.mp4         pure ISO-BMFF helpers: boxes, sidx, init (codec config), fragments (samples)
 *   BAS.avFeatures  pure feature maths: FFT, mel bands, audio frames, video frame stats
 *   BAS.mediaProbe  network + decoders (browser only): manifest, windows → features
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.mediaProbe) return;

  // ===================================================================== ISO-BMFF (pure)
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  /** Top-level boxes in b[start, end): [{type, start, end, body}] (body = offset of the payload). */
  function boxes(b, start = 0, end = b.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o), hdr = 8;
      const type = type4(b, o + 4);
      if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, end: o + size, body: o + hdr });
      o += size;
    }
    return out;
  }
  const child = (b, box, type, skip = 0) => boxes(b, box.body + skip, box.end).find((x) => x.type === type) || null;
  function path(b, box, types) {
    let cur = box;
    for (const t of types) { if (!cur) return null; cur = child(b, cur, t); }
    return cur;
  }

  /** sidx → [{start, duration, offset, size}] in seconds / absolute byte offsets. */
  function parseSidx(b, fileOffset = 0) {
    const sidx = boxes(b).find((x) => x.type === 'sidx');
    if (!sidx) return null;
    let o = sidx.body;
    const version = b[o]; o += 4;
    o += 4;                                   // reference_ID
    const timescale = u32(b, o); o += 4;
    let ept, first;
    if (version === 0) { ept = u32(b, o); first = u32(b, o + 4); o += 8; } else { ept = u64(b, o); first = u64(b, o + 8); o += 16; }
    o += 2;
    const count = u16(b, o); o += 2;
    const segs = [];
    let off = fileOffset + sidx.end + first, t = ept / timescale;
    for (let i = 0; i < count && o + 12 <= sidx.end; i++, o += 12) {
      const ref = u32(b, o), size = ref & 0x7fffffff, dur = u32(b, o + 4) / timescale;
      if (ref >>> 31) break;                  // hierarchical sidx: not used by bilibili
      segs.push({ start: t, duration: dur, offset: off, size });
      off += size; t += dur;
    }
    return { timescale, segments: segs };
  }

  /** Init segment → {kind, timescale, codec, config (Uint8Array payload of avcC/hvcC/av1C or AudioSpecificConfig), width, height, sampleRate, channels}. */
  function parseInit(b) {
    const moov = boxes(b).find((x) => x.type === 'moov');
    if (!moov) return null;
    for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak')) {
      const mdia = child(b, trak, 'mdia');
      if (!mdia) continue;
      const hdlr = child(b, mdia, 'hdlr'), mdhd = child(b, mdia, 'mdhd');
      const handler = hdlr ? type4(b, hdlr.body + 8) : '';
      const v = mdhd ? b[mdhd.body] : 0;
      const timescale = mdhd ? u32(b, mdhd.body + (v === 1 ? 20 : 12)) : 1000;
      const stsd = path(b, mdia, ['minf', 'stbl', 'stsd']);
      if (!stsd) continue;
      const entry = boxes(b, stsd.body + 8, stsd.end)[0];
      if (!entry) continue;
      if (handler === 'vide') {
        const width = u16(b, entry.body + 24), height = u16(b, entry.body + 26);
        const cfg = boxes(b, entry.body + 78, entry.end).find((x) => /^(avcC|hvcC|av1C|vpcC)$/.test(x.type));
        return { kind: 'video', timescale, fourcc: entry.type, width, height, config: cfg ? b.slice(cfg.body + (cfg.type === 'vpcC' ? 4 : 0), cfg.end) : null };
      }
      if (handler === 'soun') {
        const channels = u16(b, entry.body + 16), sampleRate = u16(b, entry.body + 24);
        const esds = boxes(b, entry.body + 28, entry.end).find((x) => x.type === 'esds');
        return { kind: 'audio', timescale, fourcc: entry.type, channels, sampleRate, config: esds ? audioSpecificConfig(b, esds.body + 4, esds.end) : null };
      }
    }
    return null;
  }
  function audioSpecificConfig(b, o, end) {
    const len = () => { let n = 0; for (let i = 0; i < 4 && o < end; i++) { const c = b[o++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    while (o < end) {
      const tag = b[o++]; const n = len();
      if (tag === 0x03) { o += 2; const f = b[o++]; if (f & 0x80) o += 2; if (f & 0x40) o += b[o] + 1; if (f & 0x20) o += 2; continue; }
      if (tag === 0x04) { o += 13; continue; }
      if (tag === 0x05) return b.slice(o, o + n);
      o += n;
    }
    return null;
  }

  /** One or more moof+mdat fragments → samples [{dts, cts, duration, key, offset, size}] (times in timescale units). */
  function parseFragments(b, base = 0) {
    const samples = [];
    for (const moof of boxes(b).filter((x) => x.type === 'moof')) {
      for (const traf of boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf')) {
        const tfhd = child(b, traf, 'tfhd'), tfdt = child(b, traf, 'tfdt');
        if (!tfhd) continue;
        const tf = (b[tfhd.body + 1] << 16) | (b[tfhd.body + 2] << 8) | b[tfhd.body + 3];
        let o = tfhd.body + 8, baseOff = moof.start, defDur = 0, defSize = 0, defFlags = 0;
        if (tf & 0x01) { baseOff = u64(b, o); o += 8; }
        if (tf & 0x02) o += 4;
        if (tf & 0x08) { defDur = u32(b, o); o += 4; }
        if (tf & 0x10) { defSize = u32(b, o); o += 4; }
        if (tf & 0x20) { defFlags = u32(b, o); o += 4; }
        let dts = 0;
        if (tfdt) dts = b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
        for (const trun of boxes(b, traf.body, traf.end).filter((x) => x.type === 'trun')) {
          const ver = b[trun.body];
          const fl = (b[trun.body + 1] << 16) | (b[trun.body + 2] << 8) | b[trun.body + 3];
          let p = trun.body + 4;
          const n = u32(b, p); p += 4;
          let dataOff = baseOff;
          if (fl & 0x01) { dataOff = baseOff + s32(b, p); p += 4; }
          let firstFlags = null;
          if (fl & 0x04) { firstFlags = u32(b, p); p += 4; }
          let off = dataOff;
          for (let i = 0; i < n; i++) {
            const dur = fl & 0x100 ? u32(b, (p += 4) - 4) : defDur;
            const size = fl & 0x200 ? u32(b, (p += 4) - 4) : defSize;
            let flags = fl & 0x400 ? u32(b, (p += 4) - 4) : defFlags;
            if (i === 0 && firstFlags != null) flags = firstFlags;
            let cto = 0;
            if (fl & 0x800) { cto = ver === 1 ? s32(b, p) : u32(b, p); p += 4; }
            samples.push({ dts, cts: dts + cto, duration: dur, key: !((flags >>> 16) & 1), offset: base + off, size });
            dts += dur; off += size;
          }
        }
      }
    }
    return samples;
  }
  BAS.mp4 = { boxes, parseSidx, parseInit, parseFragments };

  // ===================================================================== feature maths (pure)
  /** In-place radix-2 FFT (re, im of length 2^k). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const MEL_BANDS = 16;
  function melFilters(nfft, rate, nb = MEL_BANDS, fmin = 60, fmax = 7600) {
    const mel = (f) => 2595 * Math.log10(1 + f / 700), inv = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const pts = []; for (let i = 0; i < nb + 2; i++) pts.push(inv(mel(fmin) + (mel(fmax) - mel(fmin)) * i / (nb + 1)));
    const bins = pts.map((f) => Math.floor((nfft + 1) * f / rate));
    const filters = [];
    for (let m = 1; m <= nb; m++) {
      const w = new Float32Array(nfft / 2 + 1);
      for (let k = bins[m - 1]; k < bins[m]; k++) w[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
      for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
      filters.push(w);
    }
    return filters;
  }

  /**
   * Mono PCM → one feature row per `hop` seconds (window = 2 × hop):
   * {t, db, centroid (Hz), flatness (0..1), flux, zcr, mel: Float32Array(16) of log energies}.
   */
  function audioFrames(pcm, rate, t0 = 0, hop = 0.25) {
    const N = 1024, half = N / 2, filters = melFilters(N, rate);
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const re = new Float32Array(N), im = new Float32Array(N);
    const hopN = Math.max(1, Math.round(hop * rate)), stepN = half;
    const out = [];
    let prevMag = null;
    for (let h = 0; h + 2 * hopN <= pcm.length; h += hopN) {
      const acc = new Float32Array(half + 1); let frames = 0, sq = 0, zc = 0;
      for (let s = h; s + N <= h + 2 * hopN; s += stepN) {
        for (let i = 0; i < N; i++) { re[i] = pcm[s + i] * win[i]; im[i] = 0; }
        fft(re, im);
        for (let k = 0; k <= half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
        frames++;
      }
      for (let i = h; i < h + 2 * hopN; i++) { sq += pcm[i] * pcm[i]; if (i > h && (pcm[i] >= 0) !== (pcm[i - 1] >= 0)) zc++; }
      if (!frames) continue;
      let num = 0, den = 0, logSum = 0, flux = 0;
      const mag = new Float32Array(half + 1);
      for (let k = 1; k <= half; k++) {
        const p = acc[k] / frames + 1e-12; mag[k] = Math.sqrt(p);
        num += k * rate / N * p; den += p; logSum += Math.log(p);
        if (prevMag) { const d = mag[k] - prevMag[k]; if (d > 0) flux += d; }
      }
      const mel = new Float32Array(MEL_BANDS);
      for (let m = 0; m < MEL_BANDS; m++) { let e = 1e-10; const w = filters[m]; for (let k = 0; k <= half; k++) if (w[k]) e += w[k] * acc[k] / frames; mel[m] = Math.log10(e); }
      const rms = Math.sqrt(sq / (2 * hopN));
      out.push({
        t: t0 + (h + hopN) / rate,
        db: Math.max(-100, 20 * Math.log10(rms + 1e-9)),
        centroid: num / den,
        flatness: Math.exp(logSum / half) / (den / half),
        flux: prevMag ? flux / half : 0,
        zcr: zc / (2 * hopN),
        mel,
      });
      prevMag = mag;
    }
    return out;
  }

  /** RGBA pixels (w×h) → {mean, std, sat, colorful, edge, hue: Float32Array(8), gray: Float32Array(w*h)}. */
  function frameStats(px, w, h) {
    const n = w * h, gray = new Float32Array(n), hue = new Float32Array(8);
    let sum = 0, sum2 = 0, satSum = 0, rgS = 0, rgS2 = 0, ybS = 0, ybS2 = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b; gray[j] = y; sum += y; sum2 += y * y;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0; satSum += sat;
      const rg = r - g, yb = 0.5 * (r + g) - b; rgS += rg; rgS2 += rg * rg; ybS += yb; ybS2 += yb * yb;
      if (mx - mn > 12) {
        let hh;
        if (mx === r) hh = ((g - b) / (mx - mn) + 6) % 6; else if (mx === g) hh = (b - r) / (mx - mn) + 2; else hh = (r - g) / (mx - mn) + 4;
        hue[Math.min(7, Math.floor(hh / 6 * 8))] += sat;
      }
    }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const sdRg = Math.sqrt(Math.max(0, rgS2 / n - (rgS / n) ** 2)), sdYb = Math.sqrt(Math.max(0, ybS2 / n - (ybS / n) ** 2));
    const colorful = Math.sqrt(sdRg * sdRg + sdYb * sdYb) + 0.3 * Math.sqrt((rgS / n) ** 2 + (ybS / n) ** 2);
    let edge = 0;
    for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) { const k = y * w + x; edge += Math.abs(gray[k] - gray[k - 1]) + Math.abs(gray[k] - gray[k - w]); }
    edge /= (w - 1) * (h - 1);
    const hs = hue.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < 8; k++) hue[k] /= hs;
    return { mean, std, sat: satSum / n, colorful, edge, hue, gray };
  }
  /** Mean absolute luma difference between two gray vectors (0..255). */
  function grayDiff(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; }
  BAS.avFeatures = { fft, melFilters, audioFrames, frameStats, grayDiff, MEL_BANDS };

  // ===================================================================== network + decoders (browser only)
  const FRAME_W = 48, FRAME_H = 27;
  const HARD_CUT = 40;               // mean |Δluma| between consecutive frames that marks a hard cut
  const manifestCache = new Map();   // cid → {audio, video, at}
  const MANIFEST_TTL_MS = 50 * 60 * 1000;   // CDN URLs carry an expiry (deadline); refresh well before it
  const FETCH_MIN_MS = 15000, FETCH_MIN_BPS = 64 * 1024;   // an attempt may take 15 s + 1 s per 64 KB, then the next URL
  const FETCH_HEADERS_MS = 8000;     // … and must answer with headers within this (skip-here passes a shorter limit)
  const AUDIO_PIECE_SEC = 30;        // decodeAudioData holds its whole input at 48 kHz stereo: decode in pieces
  const shortSide = (v) => Math.min(+v.width || Infinity, +v.height || Infinity);   // portrait streams are 360×640

  async function getManifest(info, opts) {
    const key = String(info.cid);
    const hit = manifestCache.get(key);
    if (hit && Date.now() - hit.at < MANIFEST_TTL_MS && !(opts && opts.refresh)) return hit;
    const url = await BAS.wbi.signedUrl('https://api.bilibili.com/x/player/wbi/playurl', { bvid: info.bvid, cid: info.cid, qn: 16, fnval: 4048, fnver: 0, fourk: 0 });
    const j = await BAS.api.fetchJSON(url, opts);
    if (!j || j.code !== 0 || !j.data || !j.data.dash) throw new Error('playurl unavailable: ' + (j && j.code));
    const dash = j.data.dash;
    const urls = (x) => [x.baseUrl || x.base_url].concat(x.backupUrl || x.backup_url || []).filter(Boolean);
    const audio = (dash.audio || []).filter((a) => /^mp4a/.test(a.codecs || '') && a.segment_base).sort((a, b) => a.bandwidth - b.bandwidth)[0];
    const vids = (dash.video || []).filter((v) => v.segment_base && shortSide(v) <= 480).sort((a, b) => a.bandwidth - b.bandwidth);
    let video = null;
    if (typeof VideoDecoder !== 'undefined') {
      for (const v of vids) {
        try { const s = await VideoDecoder.isConfigSupported({ codec: v.codecs, codedWidth: v.width, codedHeight: v.height }); if (s && s.supported) { video = v; break; } } catch (e) { /* try next */ }
      }
    }
    const m = {
      at: Date.now(),
      audio: audio ? { urls: urls(audio), codecs: audio.codecs, seg: audio.segment_base, bandwidth: audio.bandwidth } : null,
      video: video ? { urls: urls(video), codecs: video.codecs, seg: video.segment_base, width: video.width, height: video.height, bandwidth: video.bandwidth } : null,
    };
    manifestCache.set(key, m);
    if (manifestCache.size > 4) manifestCache.delete(manifestCache.keys().next().value);
    return m;
  }

  const abortError = () => new DOMException('aborted', 'AbortError');
  /** Reads exactly `want` bytes, counting every byte received (also from attempts that then fail). */
  async function readExactly(r, want, stats) {
    if (!r.body || typeof r.body.getReader !== 'function') {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (stats) stats.bytes += buf.length;
      if (buf.length !== want) throw new Error(`range returned ${buf.length} of ${want} bytes`);
      return buf;
    }
    const reader = r.body.getReader(), buf = new Uint8Array(want);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (stats) stats.bytes += value.length;
      if (got + value.length > want) { try { reader.cancel(); } catch (e) { /* ignore */ } throw new Error('range longer than requested'); }
      buf.set(value, got); got += value.length;
    }
    if (got !== want) throw new Error(`range returned ${got} of ${want} bytes`);
    return buf;
  }
  /**
   * Bytes [a, b] of a track: tries the base URL, then the backups. Only an exact 206 counts (a node that ignores Range
   * would send the whole file). Each attempt must answer within `headersMs` and finish within a size-scaled limit, so a
   * stalled node cannot block the probe; a node that timed out moves to the back of the list. A 403/404 is reported in
   * preference to later errors (the caller refreshes the manifest on it). Not stored in the HTTP cache.
   */
  async function fetchRange(track, a, b, signal, stats, headersMs) {
    let lastErr = null, authErr = null;
    const want = b - a + 1, limit = FETCH_MIN_MS + Math.ceil(want / FETCH_MIN_BPS) * 1000;
    const hdr = Math.min(limit, headersMs > 0 ? headersMs : FETCH_HEADERS_MS);
    for (const url of track.urls.slice()) {
      if (signal && signal.aborted) throw abortError();
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const expire = () => { timedOut = true; ac.abort(); };
      let timer = setTimeout(expire, hdr);
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, credentials: 'omit', cache: 'no-store', signal: ac.signal });
        clearTimeout(timer); timer = setTimeout(expire, limit);
        const len = r.headers && typeof r.headers.get === 'function' ? +r.headers.get('content-length') : 0;
        if (r.status !== 206 || (len && len !== want)) {
          try { if (r.body) r.body.cancel(); } catch (e) { /* ignore */ }
          lastErr = Object.assign(new Error(r.status !== 206 ? 'HTTP ' + r.status : `range of ${len} bytes, wanted ${want}`), { status: r.status });
          if (r.status === 403 || r.status === 404) authErr = authErr || lastErr;
          continue;
        }
        return await readExactly(r, want, stats);
      } catch (e) {
        if (signal && signal.aborted) throw abortError();
        lastErr = timedOut ? Object.assign(new Error('media fetch timed out'), { name: 'TimeoutError' }) : e;
        if (timedOut) {
          const i = track.urls.indexOf(url);
          if (i >= 0 && track.urls.length > 1) { track.urls.splice(i, 1); track.urls.push(url); }
        }
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    throw authErr || lastErr || new Error('media fetch failed');
  }
  async function loadIndex(track, signal, stats, headersMs) {
    if (track._index) return track._index;
    const end = +String(track.seg.index_range).split('-')[1];
    const initEnd = +String(track.seg.initialization).split('-')[1];
    const head = await fetchRange(track, 0, end, signal, stats, headersMs);
    const init = head.slice(0, initEnd + 1);
    const sidx = parseSidx(head.slice(initEnd + 1), initEnd + 1);
    if (!sidx || !sidx.segments.length) throw new Error('no segment index');
    track._index = { init, initInfo: parseInit(init), segments: sidx.segments };
    return track._index;
  }
  /** The fragments covering [t0, t1] in one ranged request → {bytes, base, start, end, idx, segs:[{start, duration, off, size}]}. */
  async function fetchWindow(track, t0, t1, signal, stats, headersMs) {
    const idx = await loadIndex(track, signal, stats, headersMs);
    const segs = idx.segments.filter((s) => s.start + s.duration > t0 && s.start < t1);
    if (!segs.length) return null;
    const a = segs[0].offset, b = segs[segs.length - 1].offset + segs[segs.length - 1].size - 1;
    const bytes = await fetchRange(track, a, b, signal, stats, headersMs);
    return {
      bytes, base: a, start: segs[0].start, end: segs[segs.length - 1].start + segs[segs.length - 1].duration, idx,
      segs: segs.map((x) => ({ start: x.start, duration: x.duration, off: x.offset - a, size: x.size })),
    };
  }

  /**
   * Audio features for [t0, t1]. The window is decoded in pieces of ≤ 30 s; each piece also re-decodes the fragment
   * before it, so the frames around a seam (which need audio on both sides) come from the later piece.
   */
  async function audioWindow(track, t0, t1, signal, stats, headersMs) {
    const w = await fetchWindow(track, t0, t1, signal, stats, headersMs);
    if (!w) return [];
    const rate = 16000, out = [];
    for (let i = 0; i < w.segs.length;) {
      let j = i;
      while (j + 1 < w.segs.length && w.segs[j + 1].start + w.segs[j + 1].duration - w.segs[i].start <= AUDIO_PIECE_SEC) j++;
      const from = Math.max(0, i - 1);
      const piece = w.bytes.subarray(w.segs[from].off, w.segs[j].off + w.segs[j].size);
      const pcm = await decodeAudioPiece(w.idx, piece, rate);
      if (signal && signal.aborted) throw abortError();
      // the last second of the previous piece is taken from this one (it starts a fragment earlier), without a gap
      const own = i === 0 ? -Infinity : w.segs[i].start - 1;
      while (out.length && out[out.length - 1].t >= own) out.pop();
      const lastT = out.length ? out[out.length - 1].t : -Infinity;
      for (const f of audioFrames(pcm, rate, w.segs[from].start, 0.25)) if (f.t >= own && f.t > lastT + 0.125) out.push(f);
      i = j + 1;
    }
    return out.filter((f) => f.t >= t0 - 1 && f.t <= t1 + 1);
  }
  /** init + fragments → mono PCM at `rate` (all channels averaged: some uploads carry the voice on one side only). */
  async function decodeAudioPiece(idx, bytes, rate) {
    try {
      const buf = new Uint8Array(idx.init.length + bytes.length);
      buf.set(idx.init, 0); buf.set(bytes, idx.init.length);
      const ab = await new OfflineAudioContext(1, rate, rate).decodeAudioData(buf.buffer);
      const n = ab.numberOfChannels;
      if (n === 1) return ab.getChannelData(0);
      const mono = new Float32Array(ab.length);
      for (let c = 0; c < n; c++) { const ch = ab.getChannelData(c); for (let k = 0; k < mono.length; k++) mono[k] += ch[k] / n; }
      return mono;
    } catch (e) { BAS.debug('probe: decodeAudioData failed, trying WebCodecs', e && e.message); }
    if (typeof AudioDecoder !== 'undefined' && idx.initInfo && idx.initInfo.config) {
      const pcm = await decodeAacWebCodecs(idx.initInfo, bytes, rate);
      if (pcm) return pcm;
    }
    throw new Error('audio decode failed');
  }
  async function decodeAacWebCodecs(info, bytes, rate) {
    const samples = parseFragments(bytes, 0);
    const chunks = [];
    let failure = null;
    const dec = new AudioDecoder({
      output: (d) => {
        try {
          const n = d.numberOfFrames, ch = d.numberOfChannels, mono = new Float32Array(n), tmp = new Float32Array(n);
          for (let c = 0; c < ch; c++) { d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let k = 0; k < n; k++) mono[k] += tmp[k] / ch; }
          chunks.push({ sr: d.sampleRate, pcm: mono });
        } finally { d.close(); }
      },
      error: (e) => { failure = e; },
    });
    dec.configure({ codec: 'mp4a.40.2', sampleRate: info.sampleRate || 44100, numberOfChannels: info.channels || 2, description: info.config });
    for (const s of samples) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.dts / info.timescale * 1e6), data: bytes.subarray(s.offset, s.offset + s.size) }));
    try { await dec.flush(); } catch (e) { failure = failure || e; }
    if (dec.state !== 'closed') dec.close();
    if (!chunks.length) { if (failure) BAS.debug('probe: AudioDecoder failed', failure && failure.message); return null; }
    const sr = chunks[0].sr, total = chunks.reduce((a, c) => a + c.pcm.length, 0);
    const all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c.pcm, o); o += c.pcm.length; }
    // box-filter decimation to `rate`
    const ratio = sr / rate, out = new Float32Array(Math.floor(total / ratio));
    for (let i = 0; i < out.length; i++) { const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < b; k++) s += all[k]; out[i] = s / Math.max(1, b - a); }
    return out;
  }

  /** Decoded frames in [t0, t1] at ≤ fps → [{t, mean, std, sat, colorful, edge, hue, cut, drift}]. */
  async function videoWindow(track, t0, t1, opts) {
    const o = opts || {};
    const fps = o.fps || 4;
    const w = await fetchWindow(track, t0, t1, o.signal, o.stats, o.headersMs);
    if (!w || typeof VideoDecoder === 'undefined') return [];
    const info = w.idx.initInfo;
    if (!info || !info.config) throw new Error('no video config');
    const samples = parseFragments(w.bytes, 0);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(FRAME_W, FRAME_H) : Object.assign(document.createElement('canvas'), { width: FRAME_W, height: FRAME_H });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const rows = [];
    let prevGray = null, nextT = -Infinity, lastGray = null, acc = 0;
    const pending = [];
    const dec = new VideoDecoder({
      output: (frame) => {
        try {
          const t = frame.timestamp / 1e6;
          g.drawImage(frame, 0, 0, FRAME_W, FRAME_H);
          const st = frameStats(g.getImageData(0, 0, FRAME_W, FRAME_H).data, FRAME_W, FRAME_H);
          // Every decoded frame is compared with the one before it (a hard cut is one large step); rows are kept at
          // ≤ fps plus one at every hard cut. cut = largest frame-to-frame step since the previous row, drift = change
          // vs the previous row (catches fades that no single step shows).
          const d = lastGray ? grayDiff(lastGray, st.gray) : 0;
          lastGray = st.gray;
          acc = Math.max(acc, d);
          if (t >= nextT || d > HARD_CUT) {
            rows.push({ t, mean: st.mean, std: st.std, sat: st.sat, colorful: st.colorful, edge: st.edge, hue: st.hue, cut: acc, drift: prevGray ? grayDiff(prevGray, st.gray) : 0 });
            prevGray = st.gray; nextT = t + 1 / fps; acc = 0;
          }
        } finally { frame.close(); }
      },
      error: (e) => pending.push(e),
    });
    dec.configure({ codec: track.codecs, codedWidth: info.width, codedHeight: info.height, description: info.config, optimizeForLatency: false });
    // Back-pressure on the decoder's own dequeue event: setTimeout is clamped to ≥ 1 s in background tabs.
    const drained = () => new Promise((r) => {
      const to = setTimeout(r, 200);
      dec.addEventListener('dequeue', () => { clearTimeout(to); r(); }, { once: true });
    });
    for (const s of samples) {
      if (o.signal && o.signal.aborted) break;
      if (dec.state !== 'configured') break;
      dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.cts / info.timescale * 1e6), duration: Math.round(s.duration / info.timescale * 1e6), data: w.bytes.subarray(s.offset, s.offset + s.size) }));
      while (dec.decodeQueueSize > 24 && dec.state === 'configured') await drained();
    }
    if (dec.state === 'configured') { try { await dec.flush(); } catch (e) { pending.push(e); } }
    if (dec.state !== 'closed') dec.close();
    if (o.signal && o.signal.aborted) throw abortError();
    if (pending.length && !rows.length) throw pending[0];
    rows.sort((a, b) => a.t - b.t);
    return rows.filter((r) => r.t >= t0 - 1 && r.t <= t1 + 1);
  }

  /**
   * Probe [t0, t1] of the current video → {audio: frames[], video: frames[], errors: string[], bytes}. Track failures
   * are reported in `errors` (the caller decides); an aborted probe rejects with AbortError. A 403/404 (signed CDN URLs
   * expire and are bound to the client) refreshes the manifest once and retries the failed tracks.
   */
  async function probe(info, t0, t1, opts) {
    const o = opts || {};
    const out = { t0, t1, audio: [], video: [], errors: [], bytes: 0 };
    const stats = { bytes: 0 };
    const auth = (e) => !!e && (e.status === 403 || e.status === 404);
    const run = async (m, only) => {
      const failed = [];
      const jobs = [];
      const want = (k) => !only || only.includes(k);
      if (m.audio && o.audio !== false && want('audio')) jobs.push(audioWindow(m.audio, t0, t1, o.signal, stats, o.headersMs).then((x) => { out.audio = x; }, (e) => { failed.push(['audio', e]); }));
      if (m.video && o.video !== false && want('video')) jobs.push(videoWindow(m.video, t0, t1, { fps: o.fps || 4, signal: o.signal, stats, headersMs: o.headersMs }).then((x) => { out.video = x; }, (e) => { failed.push(['video', e]); }));
      await Promise.all(jobs);
      if (o.signal && o.signal.aborted) throw abortError();
      return failed;
    };
    try {
      let failed = await run(await getManifest(info, o));
      // retry only the tracks whose own failure says the signed URL is no longer valid
      const expired = failed.filter(([, e]) => auth(e)).map(([k]) => k);
      if (expired.length) failed = failed.filter(([, e]) => !auth(e)).concat(await run(await getManifest(info, Object.assign({}, o, { refresh: true })), expired));
      for (const [k, e] of failed) out.errors.push(k + ': ' + ((e && e.message) || e));
    } catch (e) {
      if (e && typeof e === 'object') { try { e.bytes = stats.bytes; } catch (_) { /* frozen */ } }
      throw e;
    }
    out.bytes = stats.bytes;
    return out;
  }

  BAS.mediaProbe = { getManifest, loadIndex, fetchRange, fetchWindow, audioWindow, videoWindow, probe, FRAME_W, FRAME_H };
})();
