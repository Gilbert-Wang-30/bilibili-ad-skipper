/* Bilibili Ad Skipper — playback watcher that performs the skips (SPEC §8). No DOM / chrome.* at load time. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) return;

  const TICK_MS = 250;              // interval guard (timeupdate alone fires only ~4 Hz and stops when paused)
  const END_MARGIN_SEC = 0.3;       // a segment is "active" for start <= t < end - margin
  const LEAVE_MARGIN_SEC = 2;       // suppression expires once playback is > 2 s outside the segment
  const OWN_SEEK_TOLERANCE_SEC = 1.5;
  const OWN_SEEK_MAX_AGE_MS = 2000;
  const DURATION_MARGIN_SEC = 0.5;  // never land closer than this to the end of the video

  const inRange = (seg, t) => t >= seg.start && t < seg.end;

  class Skipper {
    /**
     * @param {HTMLVideoElement|null} video
     * @param {{getSegments?: function(): Segment[], getSettings?: function(): object,
     *          onSkip?: function(Segment, number), onEnter?: function(Segment), onLeave?: function(Segment)}} [opts]
     */
    constructor(video, opts) {
      this._opts = Object.assign({}, opts);
      this._video = null;
      this._destroyed = false;
      /** @type {Map<string, {seg: Segment, reason: string, at: number}>} */
      this._suppressed = new Map();
      /** @type {{seg: Segment, from: number, at: number}|null} */
      this._lastSkip = null;
      /** @type {Segment|null} segment currently reported via onEnter */
      this._current = null;
      /** @type {{target: number, at: number}|null} seek we issued ourselves, to tell it apart from user seeks */
      this._ownSeek = null;
      this._onTimeUpdate = () => this._tick('timeupdate');
      this._onSeeking = () => this._handleSeeking();
      this._timer = setInterval(() => this._tick('interval'), TICK_MS);
      if (video) this.attach(video);
    }

    get video() { return this._video; }
    get lastSkip() { return this._lastSkip; }
    get currentSegment() { return this._current; }

    /** Swap the <video> element (bilibili replaces it on quality switch / new video). Keeps suppression state. */
    attach(video) {
      if (this._destroyed) return;
      if (video === this._video) return;
      this._detachListeners();
      this._leaveCurrent();
      this._ownSeek = null;
      this._video = video || null;
      if (this._video) {
        try {
          this._video.addEventListener('timeupdate', this._onTimeUpdate);
          this._video.addEventListener('seeking', this._onSeeking);
        } catch (e) { BAS.warn('Skipper: addEventListener failed', e); }
      }
    }

    /** Forget per-video state (suppressions, last skip). Call when a new video (cid) loads. */
    reset() {
      this._suppressed.clear();
      this._lastSkip = null;
      this._ownSeek = null;
      this._leaveCurrent();
    }

    /** Is this segment currently suppressed (undone or seeked into by the user)? */
    isSuppressed(seg) { return !!(seg && this._suppressed.has(this._key(seg))); }

    /** Manual skip (skip button). Returns true when a seek was issued. */
    skipNow(seg) {
      if (this._destroyed || !seg || !this._video) return false;
      const v = this._video;
      let t;
      try { t = v.currentTime; } catch { return false; }
      if (!isFinite(t)) t = seg.start;
      return this._performSkip(seg, t, 'manual');
    }

    /**
     * Undo a skip: seek back to where we left and suppress that segment.
     * With no arguments it undoes the most recent skip. Passing (seg, from) undoes that specific skip (an older toast).
     * The seek is issued even while the skip's own seek is still in flight (HTML media allows re-seeking).
     */
    undo(seg, from) {
      if (this._destroyed || !this._video) return false;
      let target = null;
      if (seg && isFinite(from)) target = { seg, from };
      else if (this._lastSkip) target = this._lastSkip;
      if (!target) return false;
      this._suppress(target.seg, 'undo');
      const ok = this._seekTo(target.from, { allowWhileSeeking: true });
      if (ok && this._lastSkip && this._key(this._lastSkip.seg) === this._key(target.seg)) this._lastSkip = null;
      return ok;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      clearInterval(this._timer);
      this._timer = null;
      this._detachListeners();
      this._leaveCurrent();
      this._video = null;
      this._suppressed.clear();
      this._lastSkip = null;
      this._ownSeek = null;
    }

    // ---------- internals ----------

    _key(seg) { return seg.id != null ? String(seg.id) : seg.start + '-' + seg.end; }

    _detachListeners() {
      const v = this._video;
      if (!v) return;
      try {
        v.removeEventListener('timeupdate', this._onTimeUpdate);
        v.removeEventListener('seeking', this._onSeeking);
      } catch { /* element may already be gone */ }
    }

    _settings() {
      try {
        const s = typeof this._opts.getSettings === 'function' ? this._opts.getSettings() : null;
        return s || (BAS.state && BAS.state.settings) || BAS.DEFAULT_SETTINGS;
      } catch (e) { BAS.debug('Skipper: getSettings threw', e); return BAS.DEFAULT_SETTINGS; }
    }

    _segments() {
      try {
        const list = typeof this._opts.getSegments === 'function' ? this._opts.getSegments() : null;
        return Array.isArray(list) ? list : [];
      } catch (e) { BAS.debug('Skipper: getSegments threw', e); return []; }
    }

    _suppress(seg, reason) {
      this._suppressed.set(this._key(seg), { seg, reason, at: Date.now() });
    }

    /** Drop suppressions once playback is clearly outside the segment. */
    _expireSuppressions(t) {
      if (!this._suppressed.size) return;
      // Re-fusion can move a segment's edges under the same id (A/V refinement). A segment the viewer chose to watch
      // stays suppressed over its current range; an auto-skip keeps the range it skipped, so a later end is skipped too.
      const current = new Map(this._segments().map((x) => [this._key(x), x]));
      for (const [key, entry] of this._suppressed) {
        const s = entry.reason === 'skipped' ? entry.seg : (current.get(key) || entry.seg);
        if (t < s.start - LEAVE_MARGIN_SEC || t > s.end + LEAVE_MARGIN_SEC) this._suppressed.delete(key);
      }
    }

    _call(name, ...args) {
      const fn = this._opts[name];
      if (typeof fn !== 'function') return;
      try { fn(...args); } catch (e) { BAS.warn('Skipper: ' + name + ' callback threw', e); }
    }

    _leaveCurrent() {
      const cur = this._current;
      if (!cur) return;
      this._current = null;
      this._call('onLeave', cur);
    }

    _enter(seg) {
      if (this._current && this._key(this._current) === this._key(seg)) {
        this._current = seg; // keep the freshest object (segments may be re-fused)
        return;
      }
      this._leaveCurrent();
      this._current = seg;
      this._call('onEnter', seg);
    }

    _readable(v) {
      try { return !!v && !v.seeking && (v.readyState | 0) >= 1; } catch { return false; }
    }

    _tick(origin) {
      if (this._destroyed) return;
      const v = this._video;
      if (!v) return;
      let t;
      try {
        if (v.seeking) return;              // SPEC: ignore timeupdate while seeking
        if ((v.readyState | 0) < 1) return; // SPEC: never act before metadata
        t = v.currentTime;
      } catch { return; }
      if (!isFinite(t)) return;

      const settings = this._settings();
      if (settings.enabled === false) { this._leaveCurrent(); return; }

      this._expireSuppressions(t);
      const segments = this._segments();
      let seg = null;
      for (const s of segments) {
        if (!s || s.enabled === false) continue;
        if (!isFinite(s.start) || !isFinite(s.end)) continue;
        if (s.start <= t && t < s.end - END_MARGIN_SEC) { seg = s; break; }
      }
      if (!seg) { this._leaveCurrent(); return; }

      const supEntry = this._suppressed.get(this._key(seg));
      const suppressed = !!supEntry;
      // Just auto/manually skipped this segment (e.g. a negative landingOffsetSec landed inside it): no button flash.
      if (supEntry && supEntry.reason === 'skipped') { this._leaveCurrent(); return; }
      const auto = settings.mode !== 'manual' && !!seg.autoSkip && !suppressed;
      if (auto) {
        this._leaveCurrent();
        if (!this._performSkip(seg, t, origin)) {
          // Could not seek right now (e.g. element not ready); keep the user informed via the button path.
          this._enter(seg);
        }
        return;
      }
      // Manual mode, low-confidence / offer-only segment, or a suppressed one: offer a button instead.
      this._enter(seg);
    }

    _landingTime(seg, settings) {
      const v = this._video;
      let offset = Number(settings && settings.landingOffsetSec);
      if (!isFinite(offset)) offset = 0;
      let target = seg.end + offset;
      let duration = NaN;
      try { duration = v.duration; } catch { /* ignore */ }
      if (isFinite(duration) && duration > 0) target = Math.min(duration - DURATION_MARGIN_SEC, target);
      // A negative offset must never land us back inside the segment's start (would loop).
      return Math.max(seg.start, target);
    }

    /** Seek to the segment's end; records lastSkip, suppresses re-skips, fires onSkip. */
    _performSkip(seg, from, origin) {
      const settings = this._settings();
      const target = this._landingTime(seg, settings);
      if (!this._seekTo(target)) return false;
      this._lastSkip = { seg, from, at: Date.now() };
      // One skip per entry: do not re-trigger until playback has clearly left the segment.
      this._suppress(seg, 'skipped');
      this._leaveCurrent();
      BAS.debug('Skipper: skipped', origin, BAS.util.fmtTime(from), '->', BAS.util.fmtTime(target), seg.reason);
      this._call('onSkip', seg, from);
      return true;
    }

    /** Low-level seek with the readiness guards. Marks the seek as our own. */
    _seekTo(target, opts) {
      const v = this._video;
      if (!v || !isFinite(target)) return false;
      if (opts && opts.allowWhileSeeking) {
        try { if ((v.readyState | 0) < 1) return false; } catch { return false; }
      } else if (!this._readable(v)) return false;
      this._ownSeek = { target, at: Date.now() };
      try {
        v.currentTime = Math.max(0, target);
      } catch (e) {
        this._ownSeek = null;
        BAS.warn('Skipper: seek failed', e);
        return false;
      }
      return true;
    }

    _handleSeeking() {
      if (this._destroyed) return;
      const v = this._video;
      if (!v) return;
      let t;
      try { t = v.currentTime; } catch { return; }
      if (!isFinite(t)) return;
      const own = this._ownSeek;
      if (own && Date.now() - own.at <= OWN_SEEK_MAX_AGE_MS && Math.abs(t - own.target) <= OWN_SEEK_TOLERANCE_SEC) {
        this._ownSeek = null;
        return;
      }
      // A user seek: any segment the target lands inside is something the user chose to watch.
      let hit = false;
      for (const s of this._segments()) {
        if (!s || !isFinite(s.start) || !isFinite(s.end)) continue;
        if (inRange(s, t)) { this._suppress(s, 'user-seek'); hit = true; }
      }
      // Seeking out of a manual segment should hide the button promptly.
      if (this._current && !inRange(this._current, t)) this._leaveCurrent();
      if (hit) BAS.debug('Skipper: user seeked into a segment at', BAS.util.fmtTime(t), '- suppressed');
    }
  }

  Skipper.TICK_MS = TICK_MS;
  BAS.Skipper = Skipper;
})();
