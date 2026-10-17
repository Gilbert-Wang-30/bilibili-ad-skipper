/* Bilibili Ad Skipper — shared namespace (loaded first). No DOM / chrome.* access at load time. */
(() => {
  if (globalThis.BAS && globalThis.BAS.__loaded) return;

  const VERSION = '0.4.1';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: 'auto',            // 'auto' | 'manual'
    minConfidence: 0.6,
    useChapters: true,
    useDanmaku: true,
    useMedia: true,
    useAudio: false,
    useHeat: true,
    useAvProbe: true,       // look-ahead audio/video check of suspected ads (37-av-segment.js)
    skipHereButton: true,   // control-bar button to skip an ad the detectors missed
    showMarkers: true,
    showToast: true,
    toastDurationMs: 6000,
    landingOffsetSec: 0,
    extraStartKeywords: [],
    extraEndKeywords: [],
    ignoreUps: [],
    debug: false,
  });

  const PREFIX = '[BAS]';
  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
  const debug = (...a) => { if (BAS.state && BAS.state.settings && BAS.state.settings.debug) console.log(PREFIX, ...a); };

  // ---------- utils ----------
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function median(arr) {
    if (!arr || !arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  const mean = (arr) => (arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    d.cancel = () => { clearTimeout(t); t = null; };
    return d;
  }
  function throttle(fn, ms) {
    let last = 0, timer = null, pendingArgs = null;
    return (...args) => {
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) { last = now; clearTimeout(timer); timer = null; fn(...args); }
      else { pendingArgs = args; if (!timer) timer = setTimeout(() => { last = Date.now(); timer = null; fn(...pendingArgs); }, remaining); }
    };
  }
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
  let uidCounter = 0;
  const uid = () => `${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

  // Full-width → half-width for digits, letters, colon and common punctuation; strip [emoji] tags; lower-case latin.
  function normalizeText(s) {
    if (!s) return '';
    let out = '';
    for (const ch of String(s)) {
      const code = ch.codePointAt(0);
      if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);      // ！..～ → !..~
      else if (code === 0x3000) out += ' ';
      else out += ch;
    }
    out = out.replace(/\[(?![^\]]*\d)[^\[\]]{1,12}\]/g, ' ');   // [doge] [前方高能] … (keeps '[4:50]')
    out = out.replace(/\s+/g, ' ').trim().toLowerCase();
    return out;
  }

  // '4:50' '04：50' '1:02:03' '4分50秒' '4分50' '4分半' '4分钟' '50秒'(only when allowBareSeconds) → seconds, else null.
  function parseTimeMention(text, duration, opts) {
    if (!text) return null;
    const s = normalizeText(text);
    const dur = isFinite(duration) && duration > 0 ? duration : Infinity;
    const ok = (v) => (v != null && isFinite(v) && v > 0 && v <= dur ? Math.round(v * 10) / 10 : null);
    let m;
    // h:mm:ss or m:ss (also with '.' or '：' which normalizeText turned into ':')
    if ((m = /(?:^|[^\d.])(\d{1,2}):(\d{1,2}):(\d{2})(?!\d)/.exec(s))) {
      const v = ok(+m[1] * 3600 + +m[2] * 60 + +m[3]); if (v != null) return v;
    }
    if ((m = /(?:^|[^\d.:])(\d{1,3}):(\d{2})(?![\d:])/.exec(s))) {
      const v = ok(+m[1] * 60 + +m[2]); if (v != null) return v;
    }
    if ((m = /(\d{1,3})分半/.exec(s))) {
      const v = ok(+m[1] * 60 + 30); if (v != null) return v;
    }
    if ((m = /(\d{1,3})分(?:钟)?(\d{1,2})?秒?/.exec(s))) {
      // '4分50秒' / '4分50' / '4分' / '4分钟'
      const secs = m[2] != null ? +m[2] : 0;
      if (m[2] != null || /分(钟)?(?![\d])/.test(s)) {
        const v = ok(+m[1] * 60 + secs); if (v != null) return v;
      }
    }
    if (opts && opts.allowBareSeconds && (m = /(?:^|[^\d])(\d{2,4})秒/.exec(s))) {
      const v = ok(+m[1]); if (v != null) return v;
    }
    return null;
  }

  // ---------- Chinese numerals (additive helpers used by the danmaku detector) ----------
  // Digit map incl. the radio-alphabet style used in 空降 memes: 洞=0 幺=1 两=2 拐=7 勾=9.
  const CN_DIGIT = { '零': 0, '〇': 0, '洞': 0, '一': 1, '幺': 1, '壹': 1, '二': 2, '两': 2, '贰': 2, '三': 3, '叁': 3, '四': 4, '肆': 4,
    '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '拐': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '勾': 9, '玖': 9 };
  const CN_RUN_RE = /[零〇洞一幺壹二两贰三叁四肆五伍六陆七拐柒八捌九勾玖十拾]+/g;
  // '十五' → 15, '二十三' → 23, '四五零' → 450 (positional when no 十), '洞四五洞' → 450. Returns null when not parseable.
  function parseChineseNumber(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return +s;
    if (/[十拾]/.test(s)) {
      const parts = s.split(/[十拾]/);
      if (parts.length !== 2) return null;
      const tens = parts[0] === '' ? 1 : (parts[0].length === 1 && CN_DIGIT[parts[0]] != null ? CN_DIGIT[parts[0]] : null);
      const ones = parts[1] === '' ? 0 : (parts[1].length === 1 && CN_DIGIT[parts[1]] != null ? CN_DIGIT[parts[1]] : null);
      if (tens == null || ones == null) return null;
      return tens * 10 + ones;
    }
    let v = 0;
    for (const ch of s) { if (CN_DIGIT[ch] == null) return null; v = v * 10 + CN_DIGIT[ch]; }
    return v;
  }
  // Replace runs of Chinese numerals with ASCII digits ('八一二工程' → '812工程', '洞四五洞' → '0450', '十五' → '15').
  // Runs that cannot be parsed are left untouched. Positional runs keep leading zeros.
  function cnToDigits(s) {
    if (!s) return '';
    return String(s).replace(CN_RUN_RE, (run) => {
      if (/[十拾]/.test(run)) { const v = parseChineseNumber(run); return v == null ? run : String(v); }
      let out = '';
      for (const ch of run) out += CN_DIGIT[ch];
      return out;
    });
  }

  // ---------- jump-target extraction (used by 31-detect-danmaku.js, exposed for tests) ----------
  // Returns [{target, kind:'abs'|'rel', fmt, weak}] where target is an absolute video time in seconds.
  //   kind 'abs'  → the text names a time (4:50, 4分50, 812工程, 0812航班, 洞四五洞, 8.12, 现在是7点46分 …)
  //   kind 'rel'  → the text names a number of → presses (向右20下 = t + 20×5 s) or seconds (30秒后)
  //   weak:true   → a bare 3–4 digit number / fuzzy decimal without any cue; the caller must require
  //                 corroboration from other danmaku (≥ 2 within 15 s agreeing ±10 s) before trusting it.
  // Only targets with t + 5 < target ≤ t + 600 (and ≤ duration) are returned; `t` is the posting time.
  const TGT = {
    // Words that mark the number as a jump destination.
    cue: /空降|跳伞|跳转|跳到|跳过|直达|到达|飞到|传送|指路|坐标|快进|正片|省流|进度条|指挥部|仙人|航班|列车|班车|登机口|工程|机场|折跃|射击距离|空警|东方|通辽|闪击|盲降|降落|着陆|落地|起飞|起火点|折跃点|高地|项目|计划|元素|便利店|航线|跳帮|跳楼|跳跃|airborne/,
    // Suffixes that turn a 3–4 digit number into a landing meme ('812工程', '0558号列车', '812号登机口').
    numSuffix: /^\s*(?:工程|航班|号|型|列车|班车|次|路|高地|项目|计划|元素|机场|登机口|客机|起火点|折跃点|便利店|局|特工|工|号列车|号航班|号登机口|分局|专案组|情报员|预警机|导航|旅|师|团|营|连)/,
    numPrefix: /(?:坐标|空降|跳伞|空警|东方|通辽|闪击|指路|直达|传送|跳到|快进到|折跃|射击距离|航班|列车|工程|前往|支援|呼叫)\s*$/,
    // A number glued to a letter is a model / train number ('x300', 'k746', 'a19'); only train-style suffixes rescue it.
    letterGlued: /[a-z]$/,
    trainSuffix: /^\s*(?:次|号|列车|航班|班车|工程)/,
    // Numbers followed by these units are prices / counts / specs, never times.
    unit: /^\s*(?:%|w\b|k\b|v\b|n\b|a\b|t\b|l\b|s\b|ms\b|m\b|kw|hp|ps|rpm|fps|bar|psi|ml|kcal|cal|°|℃|ω|万|千|百|亿|元|块|人|年|个|本|件|px|p\b|帧|mah|nm|hz|gb|mb|g\b|瓦|牛|伏|安|度|米|公里|km|cm|mm|kg|斤|岁|分辨率|评论|播放|点赞|赞|币|粉|播|像素|倍|张|集|期|楼|层|号房|公斤|毫安|w\s|多\b|左右|以上|以下|余|来个|来块|来人)/i,
    // Words before a number that make it a quantity, never a time ('智商250', '超过1500N', '售价3999').
    numQuantity: /(?:智商|iq|分数|价格|售价|只要|仅需|¥|\$|第|编号|人数|共|约|超过|大概|大约|差不多|还有|剩|至少|最多|不到|将近|接近|多达|高达|低至|卖|买|花了|赚|亏|欠|有|每分钟|每秒|每小时|每天|每年)\s*$/,
    // Whole text patterns that must never yield a numeric target (cross-part refs, highlights, counts).
    reject: /\bp\d\b|上集|下集|上一?期|下一?期|第\d+集|分钟前|小时前|天前|[百千万亿]|\d+w\b|\d+k\b|\d+\s*(?:播放|评论|点赞|在看|观看|人)|每(?:分钟|秒|小时|天|年|次)|智商|iq\b/,
    poi: /省流|封面|高能|名场面|精彩|看点|结论|总结/,
    thanks: /感谢|谢谢|多谢|蟹蟹|thx|3q/,
  };
  /**
   * The last stretch of a video. Targets past `hard` are "skip to the end" jokes and are dropped; a segment ending in
   * the `soft` zone (last 3 %) may be a sponsor read before a short outro, so it is kept but needs the audio/video check.
   */
  function endZone(duration) {
    const d = isFinite(duration) && duration > 0 ? duration : Infinity;
    if (!isFinite(d)) return { hard: Infinity, soft: Infinity };
    return { hard: d - Math.max(8, 0.01 * d), soft: d - Math.max(20, 0.03 * d) };
  }
  function extractTargets(text, t, duration) {
    const out = [];
    if (!text) return out;
    const s = normalizeText(text);
    if (!s) return out;
    const dur = isFinite(duration) && duration > 0 ? duration : Infinity;
    const tt = isFinite(t) ? t : 0;
    // Targets at the very end of the video are "skip to the end" jokes, never an ad's end.
    const minT = tt + 5, maxT = Math.min(endZone(dur).hard, tt + 600);
    const seen = new Set();
    const push = (v, kind, fmt, weak) => {
      if (v == null || !isFinite(v)) return;
      v = Math.round(v * 10) / 10;
      if (v <= minT || v > maxT) return;
      const key = kind + ':' + v;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ target: v, kind, fmt, weak: !!weak });
    };
    const sd = cnToDigits(s);                   // '八一二工程' → '812工程'
    const hasCue = TGT.cue.test(sd);
    const isThanks = TGT.thanks.test(sd);
    const rejectNumeric = TGT.reject.test(sd);
    let m;

    // 1) relative: 向右20下 / PC端向右20下 / 右17 / 往→17下 / 按21下→ / 16下 / 30秒后(with 跳|快进)
    //    A thanks danmaku with a relative form ('多谢向右20下君') is a landing marker, not a target.
    if (!isThanks) {
      // cnToDigits turns 两/拐/勾/洞/幺 into digits; right after 右/→ they are words ('右拐', '左右两个'), not counts.
      const sdRel = cnToDigits(s.replace(/([右左→⇒➡])\s*[两拐勾洞幺]/g, '$1#'));
      const relRe = /(向|往|按|请|在)?\s*(右|→|⇒|➡|>)+\s*(?:方向|边|侧|键)?\s*(?:按|滑|划|点|边)?\s*(\d{1,3})\s*(下|次|个|回)?/g;
      const shortRight = /^\s*右\s*\d{1,3}\s*(?:下|次)?[!。~]*$/.test(sdRel);    // '右17' on its own
      let found = false;
      while ((m = relRe.exec(sdRel))) {
        const prefix = m[1], arrow = m[2], n = +m[3], suffix = m[4];
        const prev = sdRel.charAt(m.index + (prefix ? prefix.length : 0) - 1);
        if (arrow === '>' && /[0-9a-z]/i.test(prev)) continue;                  // comparison: '8>6', '7nm>2nm'
        if (arrow === '右' && sdRel.lastIndexOf('左', m.index) !== -1) continue;   // '左右…'
        const pressed = !!prefix || suffix === '下' || suffix === '次' || (arrow !== '右' && arrow !== '>') || shortRight;
        if (!pressed) continue;
        if (n >= 2 && n <= 120) { push(tt + n * 5, 'rel', 'arrow'); found = true; }
      }
      if (!found && (m = /(?:^|[^\d])(\d{1,3})\s*(?:下|次)\s*(?:→|右|➡)/.exec(sd))) { const n = +m[1]; if (n >= 2 && n <= 120) push(tt + n * 5, 'rel', 'arrow'); }
      if (!found && (m = /^(\d{1,3})\s*下[!。~]*$/.exec(sd))) { const n = +m[1]; if (n >= 2 && n <= 120) push(tt + n * 5, 'rel', 'arrow'); }
      if ((m = /(\d{1,3})\s*(?:秒|s)\s*(?:后|之后)/.exec(sd)) && /跳|快进|空降|正片|广告|恰饭/.test(sd)) { const n = +m[1]; if (n >= 5 && n <= 600) push(tt + n, 'rel', 'seconds'); }
    }

    // 2) explicit clock times: h:mm:ss, m:ss (':' or ';' after normalisation), '3:00~4:50' → last one wins
    const bare = /^[\s\[\]【】()（）]*\d{1,2}[:;]\d{2}(?::\d{2})?[\s!。.~\]】)）]*$/.test(s);
    const clockRe = /(?<![\d.])(\d{1,2})[:;](\d{2})(?::(\d{2}))?(?![\d:])/g;
    const clocks = [];
    while ((m = clockRe.exec(sd))) {
      const a = +m[1], b = +m[2], c = m[3] != null ? +m[3] : null;
      if (c != null) { if (b < 60 && c < 60) clocks.push(a * 3600 + b * 60 + c); }
      else if (b < 60) clocks.push(a * 60 + b);
    }
    if (clocks.length && !/\bp\d\b|上集|下集|第\d+集/.test(sd)) {
      if (bare || hasCue || isThanks) push(clocks[clocks.length - 1], 'abs', 'clock');
      else if (!rejectNumeric) push(clocks[clocks.length - 1], 'abs', 'clock', true);
    }

    // 3) Chinese forms: 4分50秒 / 4分50 / 七分十五郎 / 4分半 / 6分整 / 现在是7点46分
    if ((m = /(\d{1,2})\s*点\s*(\d{1,2})\s*分/.exec(sd)) && +m[2] < 60) push(+m[1] * 60 + +m[2], 'abs', 'dianfen', !hasCue);
    if ((m = /(?<![\d.])(\d{1,2})\s*分\s*(\d{1,2})\s*(秒|郎|朗|君|侠|酱|哥|姐)?(?![\d])/.exec(sd)) && +m[2] < 60) {
      const explicit = !!m[3] || hasCue;
      if (!/分钟|分前|分前|评分|得分|扣分|加分/.test(sd)) push(+m[1] * 60 + +m[2], 'abs', 'fen', !explicit && !/^\s*\d{1,2}分\d{1,2}\s*$/.test(sd));
    }
    if ((m = /(?<!\d)(\d{1,2})\s*分半/.exec(sd))) push(+m[1] * 60 + 30, 'abs', 'fenban', !hasCue);
    if ((m = /(?<!\d)(\d{1,2})\s*分整/.exec(sd))) push(+m[1] * 60, 'abs', 'fenzheng', !hasCue);

    // 4) landing memes & bare numbers: 812工程 / 0812航班 / 812号登机口 / 坐标609 / 空警600 / 'k746' / bare 745 (weak)
    if (!clocks.length) {
      const numRe = /(?<![\d.:])(\d{3,4})(?![\d.:])/g;
      while ((m = numRe.exec(sd))) {
        const str = m[1];
        const before = sd.slice(Math.max(0, m.index - 6), m.index), after = sd.slice(m.index + str.length, m.index + str.length + 6);
        if (TGT.unit.test(after)) continue;
        if (/[+\/×*xX]\s*$/.test(before) || /^\s*[+\/×*]/.test(after)) continue;   // spec notation: 16+512, 12/256, 8×512
        if (/^(\d)\1+$/.test(str) || /^2+3+$/.test(str) || str === '1234' || str === '0000') continue;   // 555 / 233 / 1234
        const mm = +str.slice(0, -2), ss = +str.slice(-2);
        if (ss >= 60 || (str.length === 3 && mm === 0)) continue;
        if (TGT.numQuantity.test(before)) continue;
        if (TGT.letterGlued.test(before) && !TGT.trainSuffix.test(after)) continue;   // x300 / k90 / a19
        const cued = TGT.numSuffix.test(after) || TGT.numPrefix.test(before);
        if (!cued && (rejectNumeric || /^(19|20)\d\d$/.test(str))) continue;        // years, counts
        push(mm * 60 + ss, 'abs', cued ? 'meme' : 'number', !cued && !hasCue);
      }
      // fuzzy decimal '4.49' / '8.12机场' / '04.50' (BiliAdSkipLite style); weak unless cued
      const decRe = /(?<![\d.])(\d{1,2})\.(\d{2})(?![\d.%])/g;
      while ((m = decRe.exec(sd))) {
        const after = sd.slice(m.index + m[0].length, m.index + m[0].length + 4);
        if (+m[2] >= 60 || TGT.unit.test(after) || /^\s*(?:w|k|万|元|块|折|寸|英寸|版|代)/.test(after)) continue;
        if (rejectNumeric && !hasCue) continue;
        push(+m[1] * 60 + +m[2], 'abs', 'decimal', !hasCue);
      }
    }
    const poi = TGT.poi.test(sd);
    for (const o of out) o.poi = poi;
    return out;
  }

  // ---------- tiny event bus ----------
  const listeners = new Map();
  const events = {
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => events.off(type, fn); },
    off(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    emit(type, payload) { const s = listeners.get(type); if (!s) return; for (const fn of Array.from(s)) { try { fn(payload); } catch (e) { warn('listener error', type, e); } } },
  };

  const BAS = {
    __loaded: true,
    VERSION,
    DEFAULT_SETTINGS,
    log, warn, debug,
    state: { settings: Object.assign({}, DEFAULT_SETTINGS) },
    util: { fmtTime, clamp, median, mean, sleep, debounce, throttle, normalizeText, parseTimeMention, overlap, uid,
      parseChineseNumber, cnToDigits, extractTargets, endZone },
    events,
  };
  globalThis.BAS = BAS;
})();
