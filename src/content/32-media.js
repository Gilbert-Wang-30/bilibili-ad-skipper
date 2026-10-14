/* Bilibili Ad Skipper — media analyzer (SPEC §7.3).
 * Detects hard video cuts / black frames (and, opt-in, audio regime changes) on the page's <video>
 * so fusion can snap segment boundaries. Pure math lives in BAS.mediaMath (unit-tested in Deno);
 * BAS.MediaAnalyzer wires it to requestVideoFrameCallback / captureStream.
 * No DOM / chrome.* / location access at load time. Everything that touches the player is try/catch'd
 * and can only ever disable this analyzer — never playback. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.MediaAnalyzer) return;

  // ---------------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------------
  const FRAME_W = 32, FRAME_H = 18;      // analysis resolution (576 px)
  const HIST_BINS = 16;                  // luminance histogram bins (256 / 16 = 16 levels per bin)
  const SAMPLE_DT = 0.2;                 // seconds between frame samples (≤ 5 fps)
  const MEDIAN_SPAN_SEC = 3;             // rolling median window for mad
  const SEEK_BLOCK_MS = 1000;            // ignore frames for 1 s after 'seeking'
  const DISCONTINUITY_SEC = 1.5;         // gap between samples that invalidates the previous frame
  const CUT_DEBOUNCE = 0.4;              // min seconds between two cuts (same kind family)
  const BOTH_WINDOW = 0.6;               // audio change within this of a video cut → 'both'
  const MAX_CUTS = 2000;
  const AUDIO_FFT = 1024;
  const AUDIO_DT_MS = 200;
  const AUDIO_HISTORY = 10;              // 2 s / 200 ms
  const AUDIO_SUSTAIN = 2;               // consecutive changed samples required
  const AUDIO_COOLDOWN = 2.0;            // seconds between audio cuts

  /** Default thresholds (SPEC §7.3). Exposed as BAS.MediaAnalyzer.DEFAULTS for tuning. */
  const DEFAULTS = Object.freeze({
    mad: 40,          // mean |Δgray| (0..255) must exceed
    hist: 0.6,        // histogram L1 distance (0..2) must exceed
    ratio: 2.5,       // mad must exceed ratio × rolling median mad
    blackMean: 12,    // mean luminance below → black frame
    audioDb: 8,       // |ΔdB| vs 2 s ago
    audioCentroidRatio: 1.8,
    audioSilenceDb: -55, // below this both samples are "silent": centroid ratio is not trusted
  });

  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const debug = (...a) => { try { BAS.debug(...a); } catch (_) { /* ignore */ } };

  // ---------------------------------------------------------------------------------------------
  // Pure math (BAS.mediaMath)
  // ---------------------------------------------------------------------------------------------

  /**
   * Fixed-capacity rolling median with no per-push allocation (insertion into a small sorted buffer).
   * Capacity 15 ≈ 3 s at 5 fps.
   */
  class RollingMedian {
    constructor(capacity = 15) {
      this.capacity = Math.max(1, capacity | 0);
      this._ring = new Float64Array(this.capacity);   // values in arrival order
      this._sorted = new Float64Array(this.capacity); // same values kept sorted
      this._head = 0;                                 // next write slot in ring
      this.length = 0;
    }
    clear() { this._head = 0; this.length = 0; }
    push(v) {
      if (!isFinite(v)) return;
      const s = this._sorted;
      if (this.length === this.capacity) {
        // remove the oldest value from the sorted buffer
        const old = this._ring[this._head];
        let i = 0;
        while (i < this.length && s[i] !== old) i++;
        if (i < this.length) { for (let j = i; j < this.length - 1; j++) s[j] = s[j + 1]; this.length--; }
      }
      this._ring[this._head] = v;
      this._head = (this._head + 1) % this.capacity;
      // insert v into sorted position
      let i = this.length;
      while (i > 0 && s[i - 1] > v) { s[i] = s[i - 1]; i--; }
      s[i] = v;
      this.length++;
    }
    /** @returns {number} median of the window, NaN when empty */
    get median() {
      const n = this.length;
      if (!n) return NaN;
      const s = this._sorted, mid = n >> 1;
      return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
  }

  /**
   * Luminance features of an RGBA frame.
   * @param {Uint8ClampedArray|Uint8Array} rgba  w*h*4 bytes
   * @param {number} w
   * @param {number} h
   * @param {{gray?:Uint8Array, hist?:Float32Array}} [out] reusable buffers (gray: w*h, hist: 16)
   * @returns {{mean:number, hist:Float32Array, gray:Uint8Array}} hist is normalized (sums to 1)
   */
  function frameFeatures(rgba, w, h, out) {
    const n = (w * h) | 0;
    const o = out || {};
    if (!o.gray || o.gray.length !== n) o.gray = new Uint8Array(n);
    if (!o.hist || o.hist.length !== HIST_BINS) o.hist = new Float32Array(HIST_BINS);
    const gray = o.gray, hist = o.hist;
    hist.fill(0);
    let sum = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const g = ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3) | 0; // 0..255
      gray[p] = g;
      sum += g;
      hist[g >> 4]++;
    }
    if (n > 0) { const inv = 1 / n; for (let b = 0; b < HIST_BINS; b++) hist[b] *= inv; }
    o.mean = n > 0 ? sum / n : 0;
    return o;
  }

  /**
   * Difference between two feature sets from frameFeatures.
   * @returns {{mad:number, histDist:number}} mad 0..255 (mean |Δgray|), histDist 0..2 (L1 of normalized hists)
   */
  function frameDiff(prev, cur, out) {
    const o = out || {};
    const a = prev.gray, b = cur.gray, n = Math.min(a.length, b.length);
    let acc = 0;
    for (let p = 0; p < n; p++) { const d = a[p] - b[p]; acc += d < 0 ? -d : d; }
    let hd = 0;
    const ha = prev.hist, hb = cur.hist;
    for (let i = 0; i < HIST_BINS; i++) { const d = ha[i] - hb[i]; hd += d < 0 ? -d : d; }
    o.mad = n > 0 ? acc / n : 0;
    o.histDist = hd;
    return o;
  }

  /**
   * Cut decision (SPEC §7.3): mad > 40 && hist > 0.6 && mad > 2.5 × rollingMedian(mad).
   * A NaN / non-positive median (no history or static picture) only requires the absolute thresholds.
   */
  function isCut(diff, rollingMedianMad, thresholds) {
    const th = thresholds || DEFAULTS;
    if (!diff || !(diff.mad > th.mad) || !(diff.histDist > th.hist)) return false;
    const m = isFinite(rollingMedianMad) && rollingMedianMad > 0 ? rollingMedianMad : 0;
    return diff.mad > th.ratio * m;
  }

  /** Strength 0.4 (at thresholds) … 1 (mad ≥ 120 and hist ≥ 1.4). */
  function cutStrength(diff, thresholds) {
    const th = thresholds || DEFAULTS;
    const a = clamp((diff.mad - th.mad) / 80, 0, 1);
    const b = clamp((diff.histDist - th.hist) / 0.8, 0, 1);
    return clamp(0.4 + 0.3 * a + 0.3 * b, 0, 1);
  }

  /** RMS level in dBFS of a Float32 time-domain buffer, clamped to [-100, 0]. */
  function rmsDb(float32) {
    const n = float32 ? float32.length : 0;
    if (!n) return -100;
    let e = 0;
    for (let i = 0; i < n; i++) { const v = float32[i]; e += v * v; }
    const rms = Math.sqrt(e / n);
    if (!(rms > 0)) return -100;
    return clamp(20 * Math.log10(rms), -100, 0);
  }

  /**
   * Spectral centroid in Hz from AnalyserNode byte frequency data (frequencyBinCount = fftSize/2 bins).
   * Returns 0 for an all-zero spectrum.
   */
  function spectralCentroid(uint8Freq, sampleRate, fftSize) {
    const n = uint8Freq ? uint8Freq.length : 0;
    if (!n) return 0;
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) { const v = uint8Freq[k]; if (v) { num += k * v; den += v; } }
    if (!den) return 0;
    const binHz = (sampleRate > 0 && fftSize > 0) ? sampleRate / fftSize : 1;
    return (num / den) * binHz;
  }

  /**
   * Audio regime change between the current sample and the one 2 s ago.
   * @param {{db:number, cen:number}} cur
   * @param {{db:number, cen:number}} past
   * @returns {{changed:boolean, strength:number}}
   */
  function audioChange(cur, past, thresholds) {
    const th = thresholds || DEFAULTS;
    if (!cur || !past) return { changed: false, strength: 0 };
    const dDb = Math.abs(cur.db - past.db);
    let ratio = 1;
    if (cur.db > th.audioSilenceDb && past.db > th.audioSilenceDb && cur.cen > 20 && past.cen > 20) {
      ratio = cur.cen > past.cen ? cur.cen / past.cen : past.cen / cur.cen;
    }
    const byDb = dDb >= th.audioDb, byCen = ratio >= th.audioCentroidRatio;
    if (!byDb && !byCen) return { changed: false, strength: 0 };
    const sDb = clamp(dDb / 24, 0, 1);                       // 8 dB → 0.33, 24 dB → 1
    const sCen = clamp(Math.log(ratio) / Math.log(4), 0, 1); // ×1.8 → 0.42, ×4 → 1
    return { changed: true, strength: clamp(Math.max(sDb, sCen), 0.3, 1) };
  }

  BAS.mediaMath = { frameFeatures, frameDiff, isCut, cutStrength, rmsDb, spectralCentroid, audioChange, RollingMedian, HIST_BINS, FRAME_W, FRAME_H };

  // ---------------------------------------------------------------------------------------------
  // MediaAnalyzer
  // ---------------------------------------------------------------------------------------------

  /** @typedef {{t:number, strength:number, kind:'video'|'black'|'audio'|'both'}} Cut */

  class MediaAnalyzer {
    /**
     * @param {HTMLVideoElement|null} video
     * @param {{audio?:boolean, onCut?:(cut:Cut, how:'new'|'upgrade')=>void, thresholds?:object}} [opts]
     */
    constructor(video, opts) {
      const o = opts || {};
      this._audioEnabled = !!o.audio;
      this._onCut = typeof o.onCut === 'function' ? o.onCut : null;
      this._th = Object.assign({}, DEFAULTS, o.thresholds || {});

      /** @type {Cut[]} sorted by t */
      this._cuts = [];
      this._video = null;
      this._running = false;
      this._destroyed = false;
      this._lastError = null;
      this._errorCount = 0;

      // video sampling state
      this._videoLoopActive = false;
      this._vfcHandle = 0;
      this._vfcVideo = null;
      this._intervalId = 0;
      this._canvas = null;
      this._ctx2d = null;
      this._canvasKind = 'none';
      this._videoDisabled = false;     // set on SecurityError / missing canvas; reset on loadedmetadata
      this._buf = [
        { gray: new Uint8Array(FRAME_W * FRAME_H), hist: new Float32Array(HIST_BINS), mean: 0 },
        { gray: new Uint8Array(FRAME_W * FRAME_H), hist: new Float32Array(HIST_BINS), mean: 0 },
      ];
      this._bufIdx = 0;
      this._diff = { mad: 0, histDist: 0 };
      this._prevValid = false;
      this._prevT = -1;
      this._lastSampleT = -Infinity;
      this._blockUntil = 0;
      this._madMedian = new RollingMedian(Math.round(MEDIAN_SPAN_SEC / SAMPLE_DT));
      this._videoSamples = 0;

      // audio state
      this._actx = null;
      this._stream = null;
      this._track = null;
      this._srcNode = null;
      this._analyser = null;
      this._audioTimer = 0;
      this._audioBuilding = false;
      this._audioNeedsRebuild = false;
      this._audioRebuildTimer = 0;
      this._td = null;
      this._fd = null;
      this._aT = new Float64Array(AUDIO_HISTORY);
      this._aDb = new Float64Array(AUDIO_HISTORY);
      this._aCen = new Float64Array(AUDIO_HISTORY);
      this._aHead = 0;
      this._aCount = 0;
      this._audioRun = 0;
      this._audioRunT = 0;
      this._lastAudioCutT = -Infinity;
      this._audioSamples = 0;
      this._audioCuts = 0;
      this._resumeArmed = false;
      this._lastDb = NaN;
      this._lastCen = NaN;

      // bound handlers (one set per instance so they can be removed)
      this._onPlay = () => this._handlePlay();
      this._onPause = () => this._handlePause();
      this._onEnded = () => this._handlePause();
      this._onSeeking = () => this._handleSeeking();
      this._onLoadedMetadata = () => this._handleLoadedMetadata();
      this._onEmptied = () => this._handleEmptied();
      this._onTrackEnded = () => this._handleTrackEnded();
      this._onUserGesture = () => this._tryResume();

      if (video) this.attach(video);
    }

    // ---------------- public API ----------------

    /** @returns {Cut[]} sorted by t (live array — do not mutate) */
    get cuts() { return this._cuts; }

    /** Attach (or re-attach after the player replaced the element). Cuts are kept. */
    attach(video) {
      if (this._destroyed) return;
      if (!video || video === this._video) return;
      const wasRunning = this._running;
      if (this._video) this._detach();
      this._video = video;
      this._prevValid = false;
      this._lastSampleT = -Infinity;
      this._madMedian.clear();
      this._clearAudioHistory();
      this._videoDisabled = false;
      const add = (type, fn) => { try { video.addEventListener(type, fn); } catch (e) { this._fail('addEventListener', e); } };
      add('play', this._onPlay);
      add('playing', this._onPlay);
      add('pause', this._onPause);
      add('ended', this._onEnded);
      add('seeking', this._onSeeking);
      add('loadedmetadata', this._onLoadedMetadata);
      add('emptied', this._onEmptied);
      if (wasRunning) this._syncLoops();
    }

    /** Begin sampling (only effective while the video is playing). Idempotent. */
    start() {
      if (this._destroyed || this._running) return;
      this._running = true;
      this._syncLoops();
    }

    /** Stop sampling and release capture/audio resources. Cuts are kept. */
    stop() {
      if (!this._running) return;
      this._running = false;
      this._stopVideoLoop();
      this._stopAudio();
      this._suspendContext();
    }

    /** Forget all cuts (call when a different video (cid) starts playing in the same element). */
    clearCuts() { this._cuts.length = 0; }

    /** Release everything. The instance must not be used afterwards. */
    destroy() {
      if (this._destroyed) return;
      this.stop();
      this._detach();
      this._disarmResume();
      if (this._actx) { try { const c = this._actx; this._actx = null; const p = c.close(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ } }
      this._cuts.length = 0;
      this._onCut = null;
      this._canvas = null; this._ctx2d = null;
      this._destroyed = true;
    }

    /**
     * Nearest cut within ±window seconds of t, preferring strong cuts: minimizes |Δt| + 2·(1 − strength)
     * (so a strength-1 cut 2 s away beats a strength-0.4 cut 1 s away). Null when none.
     * @param {number} t @param {number} [window=4]
     */
    nearestCut(t, window) {
      const w = (typeof window === 'number' && window >= 0) ? window : 4;
      if (!isFinite(t) || !this._cuts.length) return null;
      const cuts = this._cuts;
      let i = lowerBound(cuts, t - w);
      let best = null, bestScore = Infinity;
      for (; i < cuts.length; i++) {
        const c = cuts[i];
        if (c.t > t + w) break;
        const dist = Math.abs(c.t - t);
        const score = dist + 2 * (1 - c.strength);
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && dist < Math.abs(best.t - t))) { best = c; bestScore = score; }
      }
      return best;
    }

    /** Cuts with a ≤ t ≤ b (inclusive), in order. */
    cutsBetween(a, b) {
      const out = [];
      if (!isFinite(a) || !isFinite(b) || b < a) return out;
      const cuts = this._cuts;
      for (let i = lowerBound(cuts, a); i < cuts.length && cuts[i].t <= b; i++) out.push(cuts[i]);
      return out;
    }

    stats() {
      let audioState = 'off';
      if (this._audioEnabled) {
        if (!this._actx) audioState = 'idle';
        else audioState = this._analyser ? ('running:' + safeGet(() => this._actx.state, '?')) : ('no-stream:' + safeGet(() => this._actx.state, '?'));
      }
      return {
        running: this._running,
        attached: !!this._video,
        cuts: this._cuts.length,
        videoSamples: this._videoSamples,
        audioSamples: this._audioSamples,
        audioCuts: this._audioCuts,
        videoLoop: this._videoLoopActive ? (this._vfcHandle ? 'rvfc' : 'interval') : 'off',
        videoDisabled: this._videoDisabled,
        canvas: this._canvasKind,
        audio: audioState,
        lastDb: this._lastDb,
        lastCentroid: this._lastCen,
        medianMad: this._madMedian.median,
        errors: this._errorCount,
        lastError: this._lastError ? String(this._lastError && this._lastError.message || this._lastError) : null,
      };
    }

    // ---------------- cut bookkeeping (protected; used by tests) ----------------

    /**
     * Insert a cut keeping the array sorted, merging with neighbours:
     *  - same-family cut within 0.4 s → keep one entry (max strength)
     *  - audio change within 0.6 s of a video/black cut (either order) → upgrade that entry to 'both'
     * @param {Cut} cut
     * @returns {Cut|null} the stored (possibly merged) entry, or null when rejected
     */
    _pushCut(cut) {
      if (!cut || !isFinite(cut.t) || cut.t < 0) return null;
      const kind = cut.kind === 'audio' || cut.kind === 'black' || cut.kind === 'both' ? cut.kind : 'video';
      const strength = isFinite(cut.strength) ? clamp(cut.strength, 0, 1) : 0.5;
      const cuts = this._cuts;
      const t = cut.t;
      const isAudio = kind === 'audio';

      // find neighbours within the widest merge window
      const lo = lowerBound(cuts, t - BOTH_WINDOW);
      let merged = null, how = 'new';
      for (let i = lo; i < cuts.length && cuts[i].t <= t + BOTH_WINDOW; i++) {
        const c = cuts[i];
        const dist = Math.abs(c.t - t);
        const cAudio = c.kind === 'audio';
        const crossFamily = isAudio !== cAudio && c.kind !== 'both';
        if (crossFamily) {
          // audio vs video/black → 'both'; keep the visual timestamp (frame-accurate)
          c.kind = 'both';
          if (cAudio && c.t !== t) { cuts.splice(i, 1); c.t = t; const p = lowerBound(cuts, t); cuts.splice(p, 0, c); }
          c.strength = strength > c.strength ? strength : Math.min(1, c.strength + 0.1);
          merged = c; how = 'upgrade';
          break;
        }
        if (dist < CUT_DEBOUNCE || c.kind === 'both') {
          // same family within debounce (or an existing 'both' nearby) → single entry
          if (strength > c.strength) { c.strength = strength; how = 'upgrade'; } else how = 'dup';
          if (kind === 'black' && c.kind === 'video') { c.kind = 'black'; how = 'upgrade'; }
          merged = c;
          break;
        }
      }
      if (merged) {
        if (how === 'upgrade') this._emit(merged, 'upgrade');
        return merged;
      }
      const entry = { t, strength, kind };
      const pos = lowerBound(cuts, t);
      if (pos === cuts.length) cuts.push(entry); else cuts.splice(pos, 0, entry);
      if (cuts.length > MAX_CUTS) cuts.splice(0, cuts.length - MAX_CUTS);
      this._emit(entry, 'new');
      return entry;
    }

    _emit(cut, how) {
      if (!this._onCut) return;
      try { this._onCut(cut, how); } catch (e) { this._fail('onCut', e); }
    }

    // ---------------- element events ----------------

    _detach() {
      const v = this._video;
      this._stopVideoLoop();
      this._stopAudio();
      if (v) {
        const rm = (type, fn) => { try { v.removeEventListener(type, fn); } catch (_) { /* ignore */ } };
        rm('play', this._onPlay); rm('playing', this._onPlay); rm('pause', this._onPause); rm('ended', this._onEnded);
        rm('seeking', this._onSeeking); rm('loadedmetadata', this._onLoadedMetadata); rm('emptied', this._onEmptied);
      }
      this._video = null;
      this._prevValid = false;
    }

    _isPlaying() {
      const v = this._video;
      if (!v) return false;
      try { return !v.paused && !v.ended; } catch (_) { return false; }
    }

    /** Start/stop loops according to running + playback state. */
    _syncLoops() {
      if (!this._running || !this._video) return;
      if (this._isPlaying()) {
        this._startVideoLoop();
        if (this._audioEnabled) { this._tryResume(); this._ensureAudio(); }
      } else {
        this._stopVideoLoop();
      }
    }

    _handlePlay() {
      this._prevValid = false;      // first frame after resume is not compared
      this._syncLoops();
    }
    _handlePause() {
      this._stopVideoLoop();
      this._audioRun = 0;
      if (this._audioEnabled) this._suspendContext();   // no audio rendering / analysis while paused
    }
    _handleSeeking() {
      this._blockUntil = nowMs() + SEEK_BLOCK_MS;
      this._prevValid = false;
      this._madMedian.clear();
      this._clearAudioHistory();
    }
    _handleLoadedMetadata() {
      // new source (quality switch / new video): fresh frame history, re-enable video, rebuild capture
      this._prevValid = false;
      this._videoDisabled = false;
      this._madMedian.clear();
      this._clearAudioHistory();
      if (this._running && this._audioEnabled) { this._stopAudio(); this._audioNeedsRebuild = true; }
      this._syncLoops();
    }
    _handleEmptied() {
      this._prevValid = false;
      this._stopVideoLoop();
      this._stopAudio();
      this._audioNeedsRebuild = true;
    }

    _fail(where, e) {
      this._errorCount++;
      this._lastError = e;
      if (this._errorCount <= 5 || this._errorCount % 100 === 0) debug('media:', where, e && e.message || e);
    }

    // ---------------- video sampling ----------------

    _ensureCanvas() {
      if (this._ctx2d) return true;
      if (this._videoDisabled) return false;
      try {
        let canvas = null;
        if (typeof OffscreenCanvas === 'function') { canvas = new OffscreenCanvas(FRAME_W, FRAME_H); this._canvasKind = 'offscreen'; }
        else if (typeof document !== 'undefined' && document.createElement) {
          canvas = document.createElement('canvas'); canvas.width = FRAME_W; canvas.height = FRAME_H; this._canvasKind = 'detached';
        }
        if (!canvas) throw new Error('no canvas available');
        // GPU-backed on purpose: with willReadFrequently the canvas is software and every drawImage(video) forces a
        // full-resolution GPU→CPU frame readback (measured ≈7 ms per sample at 1080p vs ≈0.8 ms GPU-scaled to 32×18).
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('no 2d context');
        this._canvas = canvas; this._ctx2d = ctx;
        return true;
      } catch (e) {
        this._fail('canvas', e);
        this._videoDisabled = true;
        this._canvasKind = 'none';
        return false;
      }
    }

    _startVideoLoop() {
      if (this._videoLoopActive || !this._video || this._videoDisabled) return;
      if (!this._ensureCanvas()) return;
      const video = this._video;
      this._videoLoopActive = true;
      let useVfc = false;
      try { useVfc = typeof video.requestVideoFrameCallback === 'function'; } catch (_) { useVfc = false; }
      if (useVfc) {
        const cb = (_now, meta) => {
          this._vfcHandle = 0;
          if (!this._videoLoopActive || this._video !== video) return;
          try {
            let t = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : video.currentTime;
            if (!isFinite(t)) t = 0;
            if (t < this._lastSampleT || t - this._lastSampleT >= SAMPLE_DT - 0.015) { this._lastSampleT = t; this._sampleFrame(t); }
          } catch (e) { this._fail('frame', e); }
          if (this._videoLoopActive && this._video === video) {
            try { this._vfcHandle = video.requestVideoFrameCallback(cb); }
            catch (e) { this._fail('rvfc', e); this._vfcHandle = 0; this._startIntervalLoop(video); }
          }
        };
        try { this._vfcHandle = video.requestVideoFrameCallback(cb); this._vfcVideo = video; return; }
        catch (e) { this._fail('rvfc', e); this._vfcHandle = 0; }
      }
      this._startIntervalLoop(video);
    }

    _startIntervalLoop(video) {
      if (this._intervalId) return;
      this._intervalId = setInterval(() => {
        if (!this._videoLoopActive || this._video !== video) { this._stopVideoLoop(); return; }
        try {
          const t = video.currentTime;
          if (isFinite(t) && t !== this._lastSampleT) { this._lastSampleT = t; this._sampleFrame(t); }
        } catch (e) { this._fail('frame', e); }
      }, SAMPLE_DT * 1000);
    }

    _stopVideoLoop() {
      this._videoLoopActive = false;
      if (this._vfcHandle && this._vfcVideo) {
        try { if (typeof this._vfcVideo.cancelVideoFrameCallback === 'function') this._vfcVideo.cancelVideoFrameCallback(this._vfcHandle); } catch (_) { /* ignore */ }
      }
      this._vfcHandle = 0; this._vfcVideo = null;
      if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = 0; }
    }

    /** Analyse one frame at media time t. Called ≤ 5×/s. */
    _sampleFrame(t) {
      const v = this._video, ctx = this._ctx2d;
      if (!v || !ctx) return;
      if (v.paused || v.ended || v.seeking) return;
      if (nowMs() < this._blockUntil) { this._prevValid = false; return; }
      if (v.readyState < 2) return;

      let data;
      try {
        ctx.drawImage(v, 0, 0, FRAME_W, FRAME_H);
        data = ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
      } catch (e) {
        // SecurityError (tainted direct cross-origin src) or InvalidStateError (no frame yet)
        if (e && (e.name === 'SecurityError' || /tainted|cross-origin/i.test(String(e.message)))) {
          this._fail('getImageData(tainted)', e);
          this._videoDisabled = true;
          this._stopVideoLoop();
        } else this._fail('draw', e);
        return;
      }
      if (!data || data.length < FRAME_W * FRAME_H * 4) return;

      const cur = this._buf[this._bufIdx], prev = this._buf[1 - this._bufIdx];
      frameFeatures(data, FRAME_W, FRAME_H, cur);
      this._videoSamples++;

      const discontinuity = !this._prevValid || t < this._prevT || t - this._prevT > DISCONTINUITY_SEC;
      if (!discontinuity) {
        const d = frameDiff(prev, cur, this._diff);
        const th = this._th;
        const med = this._madMedian.median;
        const isBlack = cur.mean < th.blackMean, wasBlack = prev.mean < th.blackMean;
        if (isBlack !== wasBlack) {
          // entering or leaving a black gap is a boundary
          this._pushCut({ t, strength: Math.max(0.6, cutStrength(d, th)), kind: 'black' });
        } else if (!isBlack && isCut(d, med, th)) {
          this._pushCut({ t, strength: cutStrength(d, th), kind: 'video' });
        }
        this._madMedian.push(d.mad);
      } else {
        this._madMedian.clear();
      }
      this._prevValid = true;
      this._prevT = t;
      this._bufIdx = 1 - this._bufIdx;
    }

    // ---------------- audio pipeline ----------------

    _clearAudioHistory() { this._aHead = 0; this._aCount = 0; this._audioRun = 0; }

    /** Build the capture → analyser chain if not already built. Safe to call often. */
    _ensureAudio() {
      if (!this._audioEnabled || !this._running || this._destroyed) return;
      if (this._analyser && !this._audioNeedsRebuild) return;
      if (this._audioBuilding) return;
      const v = this._video;
      if (!v) return;
      this._audioBuilding = true;
      try {
        this._stopAudio();
        this._audioNeedsRebuild = false;
        if (typeof v.captureStream !== 'function') { debug('media: captureStream unsupported'); this._audioEnabled = false; return; }
        const ACtx = (typeof AudioContext === 'function') ? AudioContext : (typeof webkitAudioContext === 'function' ? webkitAudioContext : null);
        if (!ACtx || typeof MediaStream !== 'function') { debug('media: AudioContext unsupported'); this._audioEnabled = false; return; }
        if (!(v.readyState >= 1)) { this._audioNeedsRebuild = true; return; }       // wait for loadedmetadata
        const src = safeGet(() => v.currentSrc, '');
        if (!src) { this._audioNeedsRebuild = true; return; }                      // nothing loaded → no tracks
        if (!/^blob:/i.test(src)) debug('media: direct src (may be cross-origin):', src.slice(0, 80));

        let stream;
        try { stream = v.captureStream(); }
        catch (e) {
          this._fail('captureStream', e);
          if (e && e.name === 'SecurityError') { this._audioNeedsRebuild = true; return; }   // retry on next source
          this._audioEnabled = false; return;                                                // EME / unsupported
        }
        try { stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } }); } catch (_) { /* ignore */ }
        const tracks = safeGet(() => stream.getAudioTracks(), []);
        if (!tracks || !tracks.length) {
          // no audio yet (HasAudio false or not loaded); stop and retry on play / loadedmetadata
          try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
          this._audioNeedsRebuild = true;
          debug('media: captureStream has no audio track yet');
          return;
        }
        const track = tracks[0];
        if (!this._actx) {
          try { this._actx = new ACtx({ latencyHint: 'playback' }); } catch (_) { this._actx = new ACtx(); }
        }
        const actx = this._actx;
        const srcNode = actx.createMediaStreamSource(new MediaStream([track]));
        const analyser = actx.createAnalyser();
        analyser.fftSize = AUDIO_FFT;
        analyser.smoothingTimeConstant = 0;
        srcNode.connect(analyser);                     // deliberately NOT connected to destination
        this._stream = stream; this._track = track; this._srcNode = srcNode; this._analyser = analyser;
        if (!this._td || this._td.length !== analyser.fftSize) this._td = new Float32Array(analyser.fftSize);
        if (!this._fd || this._fd.length !== analyser.frequencyBinCount) this._fd = new Uint8Array(analyser.frequencyBinCount);
        try { track.addEventListener('ended', this._onTrackEnded); } catch (_) { /* ignore */ }
        this._clearAudioHistory();
        this._tryResume();
        this._audioTimer = setInterval(() => this._audioTick(), AUDIO_DT_MS);
        debug('media: audio pipeline ready, state', actx.state);
      } catch (e) {
        this._fail('audio-setup', e);
        this._stopAudio();
        this._audioNeedsRebuild = true;
      } finally {
        this._audioBuilding = false;
      }
    }

    _stopAudio() {
      if (this._audioTimer) { clearInterval(this._audioTimer); this._audioTimer = 0; }
      if (this._audioRebuildTimer) { clearTimeout(this._audioRebuildTimer); this._audioRebuildTimer = 0; }
      if (this._track) { try { this._track.removeEventListener('ended', this._onTrackEnded); } catch (_) { /* ignore */ } }
      if (this._srcNode) { try { this._srcNode.disconnect(); } catch (_) { /* ignore */ } }
      if (this._analyser) { try { this._analyser.disconnect(); } catch (_) { /* ignore */ } }
      if (this._stream) { try { this._stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } }); } catch (_) { /* ignore */ } }
      this._stream = null; this._track = null; this._srcNode = null; this._analyser = null;
      this._clearAudioHistory();
    }

    _suspendContext() {
      const c = this._actx;
      if (!c) return;
      try { if (c.state === 'running') { const p = c.suspend(); if (p && p.catch) p.catch(() => {}); } } catch (_) { /* ignore */ }
    }

    _handleTrackEnded() {
      // source changed / playback ended: Chromium recreates tracks on 'play' / 'loadedmetadata'
      this._stopAudio();
      this._audioNeedsRebuild = true;
      if (this._running && this._audioEnabled && this._isPlaying()) {
        this._audioRebuildTimer = setTimeout(() => { this._audioRebuildTimer = 0; this._ensureAudio(); }, 100);
      }
    }

    /** Resume a suspended AudioContext; arm one-shot gesture listeners when not yet allowed. */
    _tryResume() {
      const c = this._actx;
      if (!c) return;
      let state = 'running';
      try { state = c.state; } catch (_) { return; }
      if (state !== 'suspended') return;
      let allowed = true;
      try { if (typeof navigator !== 'undefined' && navigator.userActivation) allowed = !!navigator.userActivation.hasBeenActive; } catch (_) { /* ignore */ }
      if (allowed) {
        try { const p = c.resume(); if (p && p.then) p.then(() => { debug('media: AudioContext resumed'); this._disarmResume(); }, () => this._armResume()); } catch (_) { this._armResume(); }
      } else this._armResume();
    }
    _armResume() {
      if (this._resumeArmed || typeof document === 'undefined') return;
      this._resumeArmed = true;
      try {
        document.addEventListener('pointerdown', this._onUserGesture, { capture: true, passive: true });
        document.addEventListener('keydown', this._onUserGesture, { capture: true, passive: true });
      } catch (_) { /* ignore */ }
    }
    _disarmResume() {
      if (!this._resumeArmed || typeof document === 'undefined') return;
      this._resumeArmed = false;
      try {
        document.removeEventListener('pointerdown', this._onUserGesture, { capture: true });
        document.removeEventListener('keydown', this._onUserGesture, { capture: true });
      } catch (_) { /* ignore */ }
    }

    _audioTick() {
      if (!this._isPlaying()) return;                   // paused: keep the context suspended
      const v = this._video, an = this._analyser, c = this._actx;
      if (!v || !an || !c) return;
      try {
        if (c.state !== 'running') { this._tryResume(); return; }
        if (v.paused || v.ended || v.seeking) return;
        if (nowMs() < this._blockUntil) { this._clearAudioHistory(); return; }
        an.getFloatTimeDomainData(this._td);
        an.getByteFrequencyData(this._fd);
        const db = rmsDb(this._td);
        const cen = spectralCentroid(this._fd, c.sampleRate, an.fftSize);
        const t = v.currentTime;
        this._lastDb = db; this._lastCen = cen;
        this._audioSamples++;

        // ring buffer of the last 2 s
        if (this._aCount === AUDIO_HISTORY) {
          const past = { db: this._aDb[this._aHead], cen: this._aCen[this._aHead] }; // oldest = 2 s ago
          const r = audioChange({ db, cen }, past, this._th);
          if (r.changed) {
            if (this._audioRun === 0) this._audioRunT = t;
            this._audioRun++;
            if (this._audioRun === AUDIO_SUSTAIN && t - this._lastAudioCutT >= AUDIO_COOLDOWN) {
              this._lastAudioCutT = t;
              this._audioCuts++;
              this._pushCut({ t: this._audioRunT, strength: r.strength, kind: 'audio' });
            }
          } else this._audioRun = 0;
        }
        this._aT[this._aHead] = t; this._aDb[this._aHead] = db; this._aCen[this._aHead] = cen;
        this._aHead = (this._aHead + 1) % AUDIO_HISTORY;
        if (this._aCount < AUDIO_HISTORY) this._aCount++;
      } catch (e) {
        this._fail('audio-tick', e);
      }
    }
  }

  MediaAnalyzer.DEFAULTS = DEFAULTS;
  MediaAnalyzer.MAX_CUTS = MAX_CUTS;

  // ---------------- helpers ----------------
  /** First index i with cuts[i].t >= t. */
  function lowerBound(cuts, t) {
    let lo = 0, hi = cuts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cuts[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function safeGet(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch (_) { return fallback; } }

  BAS.MediaAnalyzer = MediaAnalyzer;
})();
