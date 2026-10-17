/* Bilibili Ad Skipper — danmaku heuristic detector (SPEC §7.2).
 *
 * BAS.detectDanmaku(list, duration, settings) → {candidates: Candidate[], diagnostics}
 *
 * Rules (general, learned from 50 real videos — none is fixture-specific):
 *  R1  Classification is a single pass. Every danmaku gets a START weight by phrase class
 *      (jump cue / target-bearing 1.0, explicit ad announcement 1.0, exact-moment phrase 1.0 e.g. 零帧起手,
 *      sponsor joke 0.5 e.g. 打钱/金主/甲方/商单/广子, bare 广告/恰 0.4, weak \bad\b 0.3), an END weight
 *      (strong 1.0 e.g. 欢迎回来/空降成功/感谢NNN工程, medium 0.5 e.g. bare 谢谢/结束了) and a list of jump
 *      targets (absolute times, landing memes such as 812工程 / 0812航班 / 洞四五洞, relative 向右20下 = +100 s).
 *  R2  Negation / speculation / general-talk phrases zero the START weight ("没广告", "怎么还没到广告",
 *      "是不是商单", "开屏广告", "整期恰饭", "坐标轴", "以为/怀疑/感觉/希望 …", trailing ?/吗).
 *      Targets survive negation (a "?" after a coordinate is still a coordinate).
 *  R3  Bare numbers (745, 4.49, 6分整) are only trusted when ≥ 2 other danmaku within 15 s agree (±10 s);
 *      numbers with a cue word (坐标/工程/航班/空降 …) are trusted directly. Years / prices / counts are rejected.
 *  R4  "感谢/谢谢 + 金主|甲方|老板|催更 …" is SPONSOR vocabulary (start side, 0.5), never an end marker.
 *      "感谢 + landing number / 工程 / 空降 / 指路 / 前排 …" is a STRONG end marker — but only when its implied time
 *      is within ±25 s of the posting time; posted far earlier it is a jump target instead ("感谢600工程" at 4:14).
 *  R5  Start clusters: start items sorted by t, greedy gap ≤ 12 s; weight = Σ start weights + 1 per distinct target
 *      value; accepted when ≥ 3, or ≥ 1.5 with ≥ 2 target-bearing danmaku.
 *  R6  Start time: coordinates arrive as a sparse early wave (viewers who scrubbed back post 5–20 s before the ad)
 *      followed by a dense burst at the real start, so ts = median(first ≤ 20 jump-cue times) + 2 s (calibrated on 7
 *      ads whose onset was measured frame by frame: error −1.6 … +2.7 s, mean +0.6 s; "earliest − 3" is 8–18 s early).
 *      Without jump cues: earliest announcement − 6 s (typing lag). Never earlier than the previous accepted segment's end.
 *  R7  Intro rule: a cluster with ts < 5 s and no targets is viewers discussing the whole video → dropped;
 *      with targets it is an opening-skip OFFER (offerOnly, start 0, end = median target, confidence 0.5).
 *      Clusters driven by TL;DR / highlight cues (省流/封面/高能/名场面) are offers too.
 *  R8  End search, end-anchored ("thanks first"): inside (ts+8, ts+300] collect (a) the largest ±10 s cluster of
 *      targets posted in [ts−10, ts+120] and (b) thanks clusters (gap ≤ 10 s). Thanks clusters that contain a strong
 *      marker are preferred; medium-only clusters need score ≥ 1.5. With targets present the thanks cluster nearest
 *      to the target time is used; agreement within 20 s → end = median target; disagreement → the side with more
 *      evidence wins and confidence is penalised. Thanks posted within 10 s of any accepted start are not ends.
 *  R9  Sponsor-announcement rule: if a later start cluster with real evidence (targets or an announcement word)
 *      begins ≥ 20 s after ts and before the chosen end, the earlier cluster was an early sponsor mention → dropped.
 *  R10 Confidence (0..1) = 0.20 + min(0.35, 0.08·targetsAgree) + min(0.25, 0.08·adVocab) + strongEnd 0.20 /
 *      mediumEnd 0.08 + agreement bonus 0.10 − divergent targets 0.15 − chatty video 0.10 − disagreement 0.10.
 *      Caps: no end ≤ 0.45; end from medium thanks only ≤ 0.55; targetsAgree < 3 && adVocab < 1.5 ≤ 0.55;
 *      offerOnly ≤ 0.50. So auto-skip (≥ 0.6) needs ≥ 2 agreeing targets or a strong end marker AND sponsor vocabulary.
 *  R11 Chatty / whole-video sponsorship: start items > 1.5 % of all danmaku and no cluster has targets → −0.10.
 *  R12 Safety net (end-anchored pass): a strong landing cluster (≥ 2 strong markers) that no candidate explains, but
 *      which ≥ 2 earlier coordinates point at, becomes a candidate (same scoring).
 *  R13 Overlapping candidates: the higher confidence wins; ranges are unioned only when both are ≥ 0.6.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectDanmaku) return;
  const U = BAS.util;

  // ---------- tunables ----------
  const START_MIN = 3.0;        // cluster weight to accept a start cluster
  const START_GAP = 12;         // s between consecutive start items in one cluster
  const END_GAP = 10;           // s between consecutive thanks items in one cluster
  const TARGET_TOL = 10;        // s, targets within this are "the same"
  const AGREE_TOL = 15;         // s, target counts as agreeing with the chosen end
  const MIN_LEN = 8, MAX_LEN = 300;
  const EVIDENCE_CAP = 30;

  // ---------- patterns (exported via PATTERNS for the options page) ----------
  const P = {
    // explicit jump cues (strongest start evidence)
    jump: /空降|跳伞|跳帮|坐标|指路|仙人指路|快进到|跳到|跳转到|正片在|直达|传送门|传送到|进度条君|指挥部|请求空降|呼叫指挥部/,
    // explicit ad announcements (1.0)
    announce: /恰饭(?:了|时间|开始|来了|环节|预警|警告|啦|时刻)|开始恰饭|恰饭开始|恰上了|恰上饭|该恰饭|广告(?:来了|来咯|来力|时间|开始|预警|警告|环节|了|时间到)|广子(?:来了|来咯|来力|时间|预警)|金主来了|工商时间|工商来了|无缝插播|插播|前方(?:广告|恰饭|广子|高能恰饭)|注意(?:广告|恰饭)|软广|硬广|暗广|恭喜接单|恭喜接广|恭喜又接|接广了|接单了|有广无币|有广(?=[!。~]*$)|零帧起手|丝滑衔接|无缝衔接|无缝切换|突然变奏|可以关视频了|润物细无声|要来力|粗糙连招|恰饭警告|工商姬|恰西餐|接商单了/,
    // exact-moment phrases that are also common elsewhere → 0.5
    moment: /来了来了|前奏|变奏|变声期|声音不对|音色变了|开始了|不对劲|快跑|傻孩子们|猝不及防|画风突变|触发连招/,
    // sponsor jokes (0.5) — spammed anywhere a product is praised
    sponsor: /打钱|金主|甲方|赞助|商单|广子|恰烂钱|带货|推广|恰饭|接广|接单|工商|品牌方|老板催更|催鸽|谢甲催|信仰充值|恰个饭|恰到饭|恰上|植入|软文|恰了|恰的|恰得|让他恰|让她恰|让ta恰|要来了/,
    // bare words (0.4)
    bare: /广告|恰/,
    // weak (0.3)
    weak: /\bad\b|钱到位|金主爸爸|甲方爸爸/,
    // negation / question / speculation / whole-video / other-sense → start weight 0
    negation: /没有?广告|没有?广(?!告)|居然没有广|接不到广告|看完广告了|跳过广告了|广告了解|无广告|无广\b|不是广告|没恰|不恰|没广子|没有广子|没打钱|没给钱|哪有|怎么(?:还)?没|还没(?:到|有)?|终于没|不会有|会不会有|是不是|有没有|吗[?!。.)~]*$|[?]+$|广告位|等广告|看广告|广告都|比广告|像广告|广告片|广告牌|广告法|广告词|广告费|广告学|广告商|广告公司|广告业|打广告|做广告|拍广告|接广告|卖广告|恰饭视频|恰饭的|开屏|弹窗|插屏|贴片|广告拦截|坐标轴|坐标系|以为|怀疑|感觉|应该不是|希望|像是|不像|真不少|这么多|少点|又是|都是|期期|天天|全是|整个视频|整期|全程|空降兵|空降部队|空降ceo|空降到你|统一口径|求恰饭|快恰饭|恰饭了吗|假装恰饭|贴片广告|广告都没|多恰饭|正片结束|空降失败|坠机|没过|还在广告|落早了|落晚了|恰饭都|多少钱|不要钱|要钱|赚钱|挣钱|有钱|没钱|花钱|给钱|省钱|值钱|退钱|赔钱|亏钱|烧钱|骗钱|圈钱|工程机|工程师傅|工程量|豆腐渣工程|形象工程|面子工程/,
    // thanks that are sponsor vocabulary, not an end marker
    thanksSponsor: /(?:感谢|谢谢|多谢|谢)\s*.{0,4}?(?:金主|甲方|老板|爸爸|妈妈|妈咪|催更|催鸽|赞助|品牌|资助|冠名)/,
    // strong end markers (1.0)
    endStrong: /欢迎回来|欢迎回到|空降成功|盲降成功|成功(?:空降|着陆|降落|落地|降落伞)|安全(?:着陆|降落|落地)|平安(?:着陆|落地)|精准(?:空降|着陆|落地|降落)|已穿越|成功穿越|穿越成功|躲过一劫|逃过一劫|广告(?:结束|完了|没了|过了|结束了|完毕|终于)|恰饭(?:结束|完了|完毕)|恰(?:完|饱)了|正片(?:开始|来了|开始了)|回归正片|回到正片|上正片|回归正题|言归正传|回归视频|(?:感谢|谢谢|多谢|蟹蟹|thx|3q)\s*(?:空降|指路|提醒|前面|前排|楼上|好心人|坐标|进度条|向右|→|指挥|领航|带路)|^(?:我?回来了|回来啦|回来了回来了)[!。~]*$|已跳转|已空降|已到达|已着陆|着陆成功|落地成功|降落成功|那厮饱|恰饱|耗子吃饱/,
    // strong end markers that carry (or imply) a landing time: valid only when that time is near the posting time
    endStrongNum: /(?:感谢|谢谢|多谢)\s*.{0,6}?(?:工程|航班|列车|班车|特工|情报|预警|空警|导航|指挥部|登机|机长|机组|专案组|分局|公交|客机|号\b)/,
    // checked on cnToDigits(norm): '我是710工程' / '我是七分十五郎' / '我是6分整'
    iAm: /^我是\s*(?:\d{1,2}\s*分\s*\d{0,2}|\d{3,4})\s*(?:工程|郎|朗|分整|分半|整|半)/,
    // checked on cnToDigits(norm): '谢谢810' / '感谢七分十五郎'
    thanksNum: /(?:感谢|谢谢|多谢)\s*(\d{3,4})(?!\d)|(?:感谢|谢谢|多谢)\s*.{0,3}?\d{1,2}\s*分\s*\d{0,2}\s*(?:郎|朗|君|侠)/,
    // landing thanks win over sponsor thanks ('感谢指路老板' is a landing marker)
    thanksLanding: /(?:感谢|谢谢|多谢)\s*.{0,4}?(?:空降|指路|坐标|提醒|前排|楼上|好心人)/,
    // medium end markers (0.5)
    endMedium: /感谢|谢谢|多谢|蟹蟹|thx|3q|结束了|^好了|可以看了|回来了|回来啦|躲过|逃过|错过了|跳过了|着陆|落地|降落|正片|终于完了|完了完了|回归|吃饱了/,
    // these contain an end word but are not ends
    endNegation: /吃饱了撑|吃饱撑|撑的|正片结束|正片完|正片没|没有正片|不是正片|还在广告|空降失败|落早|落晚|还没结束|没结束|结束了吗|什么时候结束|快结束|要结束|才结束|回来看|回来补|回来投|回来三连|回来再|没回来|不回来|不要回来|回来说|回来考古|回来重|回来了吗/,
    poi: /省流|封面|高能|名场面|精彩|看点/,
  };

  // Escape a user keyword for use inside a RegExp (settings.extraStartKeywords / extraEndKeywords).
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function buildExtra(list) {
    try {
      const words = (Array.isArray(list) ? list : []).map((w) => U.normalizeText(w)).filter((w) => w && w.length >= 1);
      return words.length ? new RegExp(words.map(esc).join('|')) : null;
    } catch (e) { return null; }
  }

  /**
   * Classify one danmaku. Pure; safe to call from tests.
   * @returns {{norm:string, startW:number, startClass:string|null, negated:boolean, endW:number, endClass:string|null,
   *            targets:Array<{target:number,kind:string,fmt:string,weak:boolean,poi:boolean}>, poi:boolean, vocabW:number}}
   */
  function classify(text, t, duration, action, extra) {
    // Danmaku are short; very long texts (advanced/mode-7 payloads) are truncated so no regex can blow up (#17).
    const norm = U.normalizeText(text).slice(0, 200);
    const res = { norm, startW: 0, startClass: null, negated: false, endW: 0, endClass: null, targets: [], poi: false, vocabW: 0 };
    if (!norm && !action) return res;

    // --- targets ---
    let targets = [];
    try { targets = U.extractTargets(norm, t, duration); } catch (e) { targets = []; }
    if (action && typeof action === 'string' && action.indexOf('airborne:') === 0) {
      const v = +action.slice(9);
      let sec = null;
      if (isFinite(v) && v > 0) {
        // the unit is undocumented (observed: ms); pick whichever reading is a plausible forward jump
        const ms = v / 1000;
        if (ms > t + 5 && (!(duration > 0) || ms <= duration)) sec = ms;
        else if (duration > 0 && v > t + 5 && v <= duration) sec = v;
      }
      const endGuard = duration > 0 ? Math.max(20, 0.03 * duration) : 0;   // "skip to the end" jokes
      if (sec != null && sec > t + 5 && sec - t <= 600 && !(duration > 0 && sec > duration - endGuard)) targets.unshift({ target: Math.round(sec * 10) / 10, kind: 'abs', fmt: 'airborne', weak: false, poi: P.poi.test(norm) });
    }
    res.targets = targets;
    res.poi = P.poi.test(norm) || targets.some((x) => x.poi);

    // --- end markers ---
    const isThanks = /感谢|谢谢|多谢|蟹蟹|thx|3q/.test(norm);
    const thanksSponsor = isThanks && P.thanksSponsor.test(norm) && !P.thanksLanding.test(norm);
    if (!thanksSponsor && !P.endNegation.test(norm)) {
      const sd = U.cnToDigits(norm);
      // word-based markers (欢迎回来 / 空降成功 / 感谢指路 …) are strong regardless of any number in the text
      let strong = P.endStrong.test(norm) || (extra && extra.end ? extra.end.test(norm) : false);
      if (!strong) {
        // number-bearing landing markers ('感谢600工程' / '谢谢810' / '我是710工程' / '感谢七分十五郎') are END markers only
        // when posted near their own time (±25 s); posted far earlier they are jump targets (handled below).
        const tn = P.thanksNum.exec(sd);
        const thanksNumOk = !!tn && !(tn[1] && (/^(\d)\1+$/.test(tn[1]) || +tn[1].slice(-2) >= 60));
        if (P.endStrongNum.test(norm) || P.iAm.test(sd) || thanksNumOk) {
          const near = numericMentionNear(norm, t);
          // thanks+digits / 我是X must prove their time; keyword forms ('感谢机长') pass when no number is present
          strong = (thanksNumOk || P.iAm.test(sd)) && !P.endStrongNum.test(norm) ? near === true : near !== false;
        }
      }
      if (strong) { res.endW = 1.0; res.endClass = 'strong'; }
      else if (P.endMedium.test(norm)) {
        // 着陆/落地/降落 alone are strong only as a short exclamation ("着陆!", "落地了")
        if (/着陆|落地|降落/.test(norm) && norm.length <= 4) { res.endW = 1.0; res.endClass = 'strong'; }
        else { res.endW = 0.5; res.endClass = 'medium'; }
      }
    }

    // --- start weight by class ---
    const hasRealTarget = targets.some((x) => !x.weak);
    let cls = null, w = 0;
    if (hasRealTarget || P.jump.test(norm)) { cls = 'jump'; w = 1.0; }
    else if (targets.length) { cls = 'jump?'; w = 1.0; }                       // weak targets: confirmed later
    else if (P.announce.test(norm) || (extra && extra.start && extra.start.test(norm))) { cls = 'announce'; w = 1.0; }
    else if (thanksSponsor || P.sponsor.test(norm)) { cls = 'sponsor'; w = 0.5; }
    else if (P.moment.test(norm)) { cls = 'moment'; w = 0.5; }
    else if (P.bare.test(norm)) { cls = 'bare'; w = 0.4; }
    else if (P.weak.test(norm)) { cls = 'weak'; w = 0.3; }
    if (cls) {
      res.startClass = cls;
      // negation only suppresses the phrase evidence; coordinates keep their value
      if (cls !== 'jump' && cls !== 'jump?' && P.negation.test(norm)) { res.negated = true; w = 0; }
      else if ((cls === 'jump' || cls === 'jump?') && !targets.length && P.negation.test(norm)) { res.negated = true; w = 0; }
      res.startW = w;
      // sponsor / announcement vocabulary (NOT jump cues) feeds adVocab
      if (w > 0 && cls !== 'jump' && cls !== 'jump?') res.vocabW = w;
      else if (w > 0 && (P.announce.test(norm) || P.sponsor.test(norm))) res.vocabW = P.announce.test(norm) ? 1.0 : 0.5;
    }
    // a strong landing marker is never also a start item or a coordinate ("感谢609工程" posted 5 s before landing)
    if (res.endClass === 'strong') { res.startW = 0; res.vocabW = 0; res.startClass = null; res.targets = []; }
    return res;
  }

  // For '感谢600工程' style texts: true when the implied time is within ±25 s of t, false when it is far away,
  // null when no parseable number (then the thanks word alone decides).
  function numericMentionNear(norm, t) {
    const sd = U.cnToDigits(norm);
    let m, any = false;
    const re = /(?<![\d.])(\d{1,2})[:;.](\d{2})(?![\d])|(?<![\d.:])(\d{3,4})(?![\d.:])|(?<![\d.])(\d{1,2})\s*分\s*(\d{1,2})?\s*(整|半)?/g;
    while ((m = re.exec(sd))) {
      let v;
      if (m[1] != null) v = +m[1] * 60 + +m[2];
      else if (m[3] != null) { const s = m[3]; const ss = +s.slice(-2); if (ss >= 60) continue; v = +s.slice(0, -2) * 60 + ss; }
      else { if (m[5] == null && m[6] == null) continue; v = +m[4] * 60 + (m[5] != null ? +m[5] : m[6] === '半' ? 30 : 0); }
      any = true;
      if (Math.abs(v - t) <= 25) return true;
    }
    return any ? false : null;
  }

  // ---------- main ----------
  function detectDanmaku(list, duration, settings) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const out = { candidates: [], diagnostics: { total: 0, startItems: 0, targetItems: 0, endItems: 0, clusters: [], density: [], chatty: false, elapsedMs: 0 } };
    try {
      const dur = isFinite(+duration) && +duration > 0 ? +duration : 0;   // Infinity / NaN → unknown
      run(Array.isArray(list) ? list : [], dur, settings || BAS.state.settings || BAS.DEFAULT_SETTINGS, out);
    } catch (e) {
      BAS.warn('detectDanmaku failed', e);
      out.diagnostics.error = String(e && e.message || e);
    }
    out.diagnostics.elapsedMs = Math.round((((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0) * 10) / 10;
    return out;
  }

  function run(list, duration, settings, out) {
    const D = out.diagnostics;
    const extra = { start: buildExtra(settings.extraStartKeywords), end: buildExtra(settings.extraEndKeywords) };
    const hasExtra = !!(extra.start || extra.end);
    const n = list.length;
    D.total = n;
    const nBins = Math.min(86400 / 5, Math.max(1, Math.ceil((duration || 1) / 5)));
    const density = new Array(nBins).fill(0);

    // ---- Step A: classify (single pass) ----
    const items = [];           // {t, text, c:classification}
    for (let i = 0; i < n; i++) {
      const d = list[i];
      if (!d) continue;
      const t = +d.t || 0;
      const b = Math.min(nBins - 1, Math.max(0, Math.floor(t / 5)));
      density[b]++;
      const text = d.text == null ? '' : String(d.text);
      if (!text && !d.action) continue;
      // cheap pre-filter: skip texts that cannot carry any signal (disabled when user keywords are configured)
      if (!d.action && !hasExtra && !PREFILTER.test(U.normalizeText(text))) continue;
      const c = classify(text, t, duration, d.action, extra);
      if (c.startW > 0 || c.endW > 0 || c.targets.length) items.push({ t, text, c });
    }
    items.sort((a, b) => a.t - b.t);
    D.density = density;

    // ---- R3: confirm weak targets (≥ 2 other danmaku within 15 s agreeing ±10 s, ≥ 1 of them cued) ----
    // Evaluated against the ORIGINAL weak/cued flags (order-independent, no chaining through freshly confirmed targets),
    // with early exit and a probe cap so a burst of thousands of identical bare numbers stays cheap.
    const R3_MAX_PROBES = 60;
    const tIdx = [];
    for (let i = 0; i < items.length; i++) if (items[i].c.targets.length) tIdx.push(i);
    const confirmed = new Set();
    for (let k = 0; k < tIdx.length; k++) {
      const it = items[tIdx[k]];
      for (const tg of it.c.targets) {
        if (!tg.weak) continue;
        let agree = 0, cued = 0;
        const probe = (j) => {
          let a = false, c = false;
          for (const y of items[tIdx[j]].c.targets) {
            if (Math.abs(y.target - tg.target) <= TARGET_TOL) { a = true; if (!y.weak) { c = true; break; } }
          }
          if (a) { agree++; if (c) cued++; }
          return agree >= 2 && cued >= 1;
        };
        let done = false;
        for (let j = k - 1, n = 0; !done && j >= 0 && n < R3_MAX_PROBES && it.t - items[tIdx[j]].t <= 15; j--, n++) done = probe(j);
        for (let j = k + 1, n = 0; !done && j < tIdx.length && n < R3_MAX_PROBES && items[tIdx[j]].t - it.t <= 15; j++, n++) done = probe(j);
        if (agree >= 2 && cued >= 1) confirmed.add(tg);
      }
    }
    for (const i of tIdx) {
      const it = items[i];
      if (!it.c.targets.some((x) => x.weak)) continue;
      const keep = it.c.targets.filter((x) => !x.weak || confirmed.has(x));
      for (const x of keep) x.weak = false;
      it.c.targets = keep;
      if (!keep.length && it.c.startClass === 'jump?') { it.c.startClass = null; it.c.startW = 0; }
      else if (keep.length && it.c.startClass === 'jump?') it.c.startClass = 'jump';
    }

    const startItems = items.filter((x) => x.c.startW > 0);
    const endItems = items.filter((x) => x.c.endW > 0);
    const targetItems = items.filter((x) => x.c.targets.length);
    D.startItems = startItems.length; D.endItems = endItems.length; D.targetItems = targetItems.length;

    // ---- Step B: start clusters (greedy, gap ≤ 12 s) ----
    const clusters = [];
    let cur = null;
    for (const it of startItems) {
      if (!cur || it.t - cur.last > START_GAP) { cur = { items: [], first: it.t, last: it.t }; clusters.push(cur); }
      cur.items.push(it); cur.last = it.t;
    }
    for (const cl of clusters) {
      cl.weight = 0; cl.coreWeight = 0; cl.announceW = 0; cl.targetItems = []; cl.poi = false;
      for (const it of cl.items) {
        cl.weight += it.c.startW;
        if (it.c.startClass !== 'moment') cl.coreWeight += it.c.startW;      // "来了来了" alone never makes a cluster
        if (it.c.startClass === 'announce') cl.announceW += it.c.startW;
        if (it.c.targets.length) { cl.targetItems.push(it); if (it.c.poi) cl.poi = true; }
      }
      cl.distinctTargets = groupTargets(cl.targetItems.flatMap((x) => x.c.targets.map((y) => y.target))).length;
      cl.weight += cl.distinctTargets; cl.coreWeight += cl.distinctTargets;
      cl.accepted = (cl.weight >= START_MIN && cl.coreWeight >= 1.5) || (cl.targetItems.length >= 2 && cl.weight >= 1.5);
      cl.real = cl.targetItems.length > 0 || cl.announceW >= 1.0;              // evidence of an actual ad start
    }
    const accepted = clusters.filter((c) => c.accepted);
    const anyTargets = accepted.some((c) => c.targetItems.length > 0);
    D.chatty = n > 0 && startItems.length / n > 0.015 && !anyTargets;   // R11
    const chatty = D.chatty;

    // ---- Step C/D: evaluate each accepted cluster ----
    const cands = [];
    let prevEnd = 0;
    for (const cl of accepted) cl.ts0 = startEstimate(cl);
    // thanks posted within 10 s of a *real* start (jump cues / announcements) are part of the start burst, not an end
    const realTs = accepted.filter((c) => c.real).map((c) => c.ts0);
    for (let i = 0; i < accepted.length; i++) {
      const cl = accepted[i];
      if (cl.last < prevEnd) { D.clusters.push(summ(cl, 'inside-previous')); continue; }   // chatter inside the previous ad
      cl.ts = Math.max(cl.ts0, prevEnd);                       // never earlier than the previous accepted segment's end
      const nextTs = i + 1 < accepted.length ? accepted[i + 1].ts0 : Infinity;
      // R7 intro rule (a coordinate burst that begins at t≈0 is an opening skip even when its median lands a bit later)
      const firstJump = cl.items.find((x) => x.c.startClass === 'jump' && x.c.startW > 0);
      if (cl.ts < 5 || (firstJump && firstJump.t < 3 && cl.ts < 15)) {
        if (!cl.targetItems.length) { D.clusters.push(summ(cl, 'intro-dropped')); continue; }
        const vals = cl.targetItems.flatMap((x) => x.c.targets.map((y) => y.target));
        const g = largestGroup(vals);
        const end = U.median(g);
        if (end >= MIN_LEN && end - 0 <= Math.max(MAX_LEN, 0) + 300) {
          cands.push(mk(cl, 0, end, 0.5, true, { targetsAgree: g.length, adVocab: 0, strongEnd: 0, mediumEnd: 0, endSource: 'target', divergent: g.length * 2 < vals.length, teTarget: end }, null, null));
          D.clusters.push(summ(cl, 'intro-offer'));
        }
        continue;
      }
      const ev = evaluate(cl, cl.ts, nextTs, duration, items, targetItems, endItems, realTs, chatty);
      // R9 sponsor-announcement rule: a clearly stronger ad start begins inside this cluster's range
      if (ev.end != null) {
        for (let j = i + 1; j < accepted.length; j++) {
          const later = accepted[j];
          if (later.ts0 >= ev.end) break;
          if (later.ts0 < cl.ts + 20 || later.weight < START_MIN) continue;
          const moreTargets = later.targetItems.length >= 2 && later.targetItems.length > 2 * cl.targetItems.length;
          const announced = cl.targetItems.length === 0 && later.announceW >= 1.0 && later.weight >= cl.weight;
          if (moreTargets || announced) { ev.end = null; ev.invalidatedBy = later.ts0; break; }
        }
      }
      if (ev.invalidatedBy != null) { D.clusters.push(summ(cl, 'superseded')); continue; }
      const cand = mk(cl, cl.ts, ev.end, ev.conf, ev.offerOnly, ev, ev.thanks, ev.targets);
      cands.push(cand);
      if (ev.end != null && ev.conf >= 0.6) prevEnd = Math.max(prevEnd, ev.end);
      D.clusters.push(summ(cl, ev.end == null ? 'no-end' : 'ok'));
    }

    // ---- R12: end-anchored safety net ----
    try { endAnchored(cands, clusters, endItems, targetItems, items, duration, chatty, D); } catch (e) { BAS.debug('endAnchored failed', e); }

    // ---- Step E: merge / sort ----
    out.candidates = merge(cands.filter((c) => c.end == null || c.end > c.start));
  }

  const PREFILTER = /[\d零〇一二三四五六七八九十洞幺两拐勾]|广|恰|空降|跳|指路|坐标|快进|正片|谢|thx|3q|金主|甲方|打钱|商单|赞助|推广|回来|回归|着陆|落地|降落|穿越|躲过|逃过|错过|插播|带货|\bad\b|工程|航班|→|右|结束|好了|可以看了|前奏|变奏|接单|接广|零帧|丝滑|无缝|关视频|润物|有广|钱到位|省流|直达|传送|指挥部|饱|不对劲|快跑|来了|开始了|变声|声音不对|猝不及防|画风|连招|工商|植入|软文|品牌|催鸽|信仰|言归|正传|正题|完了/;

  function startEstimate(cl) {
    const jumps = cl.items.filter((x) => x.c.startClass === 'jump' && x.c.startW > 0);
    if (jumps.length) {
      // R6: coordinates arrive as a sparse early wave (viewers who scrubbed back) followed by a dense burst right at
      // the ad start. Against 7 frame-measured ad onsets the median of the first ≤ 20 posts lands 0.7–3.6 s BEFORE the
      // onset (mean 1.4 s), so +2 s is centred while erring towards showing a second of ad rather than cutting content.
      const head = jumps.slice(0, 20).map((x) => x.t);
      return Math.max(0, U.median(head) + 2);
    }
    // Without coordinates: on the 7 frame-measured ads the first explicit announcement lags the onset by −2.1 … +2.9 s
    // (median ≈ 0), so subtracting a typing lag would cut content; −1 s keeps the error centred.
    const ann = cl.items.filter((x) => x.c.startClass === 'announce');
    if (ann.length) return Math.max(0, ann[0].t - 1);
    const strong = cl.items.filter((x) => x.c.startW >= 0.4);
    return Math.max(0, (strong.length ? strong[0].t : cl.first) - 1);
  }

  function evaluate(cl, ts, nextTs, duration, items, targetItems, endItems, realTs, chatty) {
    const lo = ts + MIN_LEN, hi = Math.min(ts + MAX_LEN, duration > 0 ? duration : ts + MAX_LEN);
    const r = { end: null, conf: 0, offerOnly: false, targets: [], thanks: [], targetsAgree: 0, adVocab: 0, strongEnd: 0, mediumEnd: 0, endSource: null, divergent: false, teTarget: null, teThanks: null, nTarget: 0, thanksScore: 0 };

    // 1) targets posted in [ts-10, min(ts+120, nextTs)] with values in the window
    const postHi = Math.min(ts + 120, nextTs);
    const tItems = [];
    for (let i = lowerBound(targetItems, ts - 10); i < targetItems.length; i++) {
      const it = targetItems[i];
      if (it.t < ts - 10) continue;
      if (it.t > postHi) break;
      const vals = it.c.targets.map((x) => x.target).filter((v) => v > lo && v <= hi);
      if (vals.length) tItems.push({ it, vals });
    }
    const allVals = tItems.flatMap((x) => x.vals);
    let teTarget = null, nTarget = 0;
    if (allVals.length) {
      const g = largestGroup(allVals);
      teTarget = U.median(g); nTarget = g.length;
      r.divergent = g.length * 2 < allVals.length;
    }
    r.teTarget = teTarget; r.nTarget = nTarget;

    // 2) thanks clusters inside (max(lo, ts+10), hi]; those starting within 10 s of any accepted start are not ends
    const eItems = [];
    for (let i = lowerBound(endItems, Math.max(lo, ts + 10)); i < endItems.length; i++) {
      const it = endItems[i];
      if (it.t <= Math.max(lo, ts + 10)) continue;
      if (it.t > hi) break;
      eItems.push(it);
    }
    const eClusters = [];
    let cur = null;
    for (const it of eItems) {
      if (!cur || it.t - cur.last > END_GAP) { cur = { items: [], first: it.t, last: it.t, score: 0, strong: 0, medium: 0, firstStrong: null }; eClusters.push(cur); }
      cur.items.push(it); cur.last = it.t; cur.score += it.c.endW;
      if (it.c.endClass === 'strong') { cur.strong++; if (cur.firstStrong == null) cur.firstStrong = it.t; } else cur.medium++;
    }
    for (const ec of eClusters) {
      ec.te = Math.max(0, (ec.firstStrong != null ? ec.firstStrong : ec.first) - 2);
      ec.nearStart = realTs.some((s) => Math.abs(ec.first - s) <= 10 && Math.abs(s - ts) > 10);
      ec.ok = !ec.nearStart && ((ec.strong >= 1 && ec.score >= 1.0) || ec.score >= 1.5);
    }
    const okClusters = eClusters.filter((e) => e.ok);
    let chosen = null;
    if (okClusters.length) {
      if (teTarget != null) {
        const strongOnes = okClusters.filter((e) => e.strong >= 1);
        const pool = strongOnes.length ? strongOnes : okClusters;
        chosen = pool.reduce((best, e) => (best == null || Math.abs(e.te - teTarget) < Math.abs(best.te - teTarget) ? e : best), null);
        // a medium-only cluster that sits exactly on the target beats a far-away strong one
        if (strongOnes.length && Math.abs(chosen.te - teTarget) > 30) {
          const nearest = okClusters.reduce((best, e) => (best == null || Math.abs(e.te - teTarget) < Math.abs(best.te - teTarget) ? e : best), null);
          if (nearest && Math.abs(nearest.te - teTarget) <= 20) chosen = nearest;
        }
      } else {
        chosen = okClusters.find((e) => e.strong >= 2) || okClusters.find((e) => e.strong >= 1) || okClusters[0];
      }
    }
    const teThanks = chosen ? chosen.te : null;
    r.teThanks = teThanks; r.thanksScore = chosen ? chosen.score : 0;

    // 3) decide
    let end = null, disagree = false;
    if (teTarget != null && teThanks != null) {
      if (Math.abs(teTarget - teThanks) <= 20) { end = teTarget; r.endSource = 'both'; }
      else { disagree = true; if (nTarget >= chosen.score) { end = teTarget; r.endSource = 'target'; } else { end = teThanks; r.endSource = 'thanks'; } }
    } else if (teTarget != null) { end = teTarget; r.endSource = 'target'; }
    else if (teThanks != null) { end = teThanks; r.endSource = 'thanks'; }
    if (end != null && (end - ts < MIN_LEN || end - ts > MAX_LEN)) { end = null; r.endSource = null; }
    r.end = end == null ? null : Math.round(end * 10) / 10;

    // 4) confidence
    const endRef = end != null ? end : teTarget;
    if (endRef != null) for (const x of tItems) if (x.vals.some((v) => Math.abs(v - endRef) <= AGREE_TOL)) r.targetsAgree++;
    for (let i = lowerBound(items, ts - 10); i < items.length; i++) {
      const it = items[i];
      if (it.t > ts + 60) break;
      r.adVocab += it.c.vocabW || 0;
    }
    const endCluster = (end != null && chosen && (r.endSource === 'both' || r.endSource === 'thanks' || Math.abs(chosen.te - end) <= 20)) ? chosen : null;
    r.strongEnd = endCluster ? endCluster.strong : 0;
    r.mediumEnd = endCluster ? endCluster.medium : 0;
    let conf = 0.20
      + Math.min(0.35, 0.08 * r.targetsAgree)
      + Math.min(0.25, 0.08 * r.adVocab)
      + (r.strongEnd >= 1 ? 0.20 : r.mediumEnd >= 1 ? 0.08 : 0)
      + (r.targetsAgree >= 2 && r.strongEnd >= 1 && teThanks != null && teTarget != null && Math.abs(teTarget - teThanks) <= 15 ? 0.10 : 0)
      - (r.divergent ? 0.15 : 0) - (chatty ? 0.10 : 0) - (disagree ? 0.10 : 0);
    if (end == null) conf = Math.min(conf, 0.45);
    if (end != null && r.endSource === 'thanks' && r.strongEnd === 0 && r.targetsAgree === 0) conf = Math.min(conf, 0.55);
    if (end != null && r.strongEnd === 0 && r.targetsAgree < 2) conf = Math.min(conf, 0.55);
    if (r.targetsAgree < 3 && r.adVocab < 1.5) conf = Math.min(conf, 0.55);
    // sponsor jokes + a lone generic thanks are not enough: without coordinates an explicit announcement is required
    if (r.targetsAgree < 2 && (cl.announceW || 0) < 1.0) conf = Math.min(conf, 0.55);
    r.offerOnly = cl.poi && cl.targetItems.length > 0 && cl.targetItems.every((x) => x.c.poi);
    if (r.offerOnly) conf = Math.min(conf, 0.50);
    r.conf = Math.round(U.clamp(conf, 0, 1) * 100) / 100;
    r.targets = tItems.map((x) => x.it);
    r.thanks = endCluster ? endCluster.items : [];
    return r;
  }

  // R12: strong landing clusters nobody explains, pointed at by ≥ 2 earlier coordinates.
  function endAnchored(cands, clusters, endItems, targetItems, items, duration, chatty, D) {
    const eCl = [];
    let cur = null;
    for (const it of endItems) {
      if (!cur || it.t - cur.last > END_GAP) { cur = { items: [], first: it.t, last: it.t, strong: 0, firstStrong: null }; eCl.push(cur); }
      cur.items.push(it); cur.last = it.t;
      if (it.c.endClass === 'strong') { cur.strong++; if (cur.firstStrong == null) cur.firstStrong = it.t; }
    }
    for (const ec of eCl) {
      if (ec.strong < 2) continue;
      const te = ec.firstStrong - 2;
      if (cands.some((c) => c.end != null && Math.abs(c.end - te) <= 25)) continue;
      const pointing = [];
      for (let i = lowerBound(targetItems, te - MAX_LEN); i < targetItems.length && targetItems[i].t <= te - MIN_LEN; i++) {
        const it = targetItems[i];
        if (it.c.targets.some((x) => Math.abs(x.target - te) <= AGREE_TOL)) pointing.push(it);
      }
      if (pointing.length < 2) continue;
      const first = pointing[0], last = pointing[pointing.length - 1];
      const pseudo = { items: items.filter((x) => x.c.startW > 0 && x.t >= first.t - START_GAP && x.t <= last.t + START_GAP), first: first.t, last: last.t, weight: 0, announceW: 0, targetItems: pointing, poi: false };
      for (const it of pseudo.items) { pseudo.weight += it.c.startW; if (it.c.startClass === 'announce') pseudo.announceW += it.c.startW; }
      pseudo.distinctTargets = 1; pseudo.weight += 1;
      pseudo.ts = startEstimate(pseudo);
      if (pseudo.ts < 5) continue;
      const ev = evaluate(pseudo, pseudo.ts, Infinity, duration, items, targetItems, endItems, [], chatty);
      if (ev.end == null) continue;
      if (cands.some((c) => c.end != null && U.overlap(c.start, c.end, pseudo.ts, ev.end) > 0.5 * (ev.end - pseudo.ts))) continue;
      cands.push(mk(pseudo, pseudo.ts, ev.end, ev.conf, ev.offerOnly, ev, ev.thanks, ev.targets));
      D.clusters.push(summ(pseudo, 'end-anchored'));
    }
  }

  // ---------- helpers ----------
  /** First index i with arr[i].t >= t (arr sorted by t). */
  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function groupTargets(vals) {
    const s = vals.slice().sort((a, b) => a - b);
    const groups = [];
    let g = null;
    for (const v of s) {
      if (!g || v - g[g.length - 1] > TARGET_TOL) { g = []; groups.push(g); }
      g.push(v);
    }
    return groups;
  }
  function largestGroup(vals) {
    const groups = groupTargets(vals);
    let best = [];
    for (const g of groups) if (g.length > best.length) best = g;     // tie → earliest
    return best;
  }
  function summ(cl, status) {
    return { ts: cl.ts, first: cl.first, last: cl.last, weight: Math.round(cl.weight * 10) / 10, items: cl.items.length, targets: cl.targetItems.length, status };
  }
  function mk(cl, start, end, conf, offerOnly, ev, thanksItems, targetItems) {
    const nStart = cl.items.length, nTarget = ev.targetsAgree || 0, nThanks = (thanksItems || []).length;
    const cand = {
      start: Math.round(start * 10) / 10,
      end: end == null ? null : Math.round(end * 10) / 10,
      source: 'danmaku',
      confidence: conf,
      reason: '弹幕 ' + nStart + ' 条 · 空降 ' + nTarget + ' 条 · 感谢 ' + nThanks + ' 条',
      evidence: {
        startItems: cl.items.slice(0, EVIDENCE_CAP).map((x) => ({ t: x.t, text: x.text })),
        targets: (targetItems || cl.targetItems).slice(0, EVIDENCE_CAP).map((x) => ({ t: x.t, text: x.text, target: x.c.targets[0] ? x.c.targets[0].target : null })),
        thanks: (thanksItems || []).slice(0, EVIDENCE_CAP).map((x) => ({ t: x.t, text: x.text })),
        ts: Math.round(start * 10) / 10, teTarget: ev.teTarget == null ? null : Math.round(ev.teTarget * 10) / 10, teThanks: ev.teThanks == null ? null : Math.round(ev.teThanks * 10) / 10,
        targetsAgree: ev.targetsAgree, adVocab: Math.round((ev.adVocab || 0) * 10) / 10, strongEnd: ev.strongEnd, mediumEnd: ev.mediumEnd, endSource: ev.endSource, divergent: !!ev.divergent, clusterWeight: Math.round(cl.weight * 10) / 10,
      },
    };
    if (offerOnly) cand.offerOnly = true;
    return cand;
  }
  // R13
  function merge(cands) {
    // An opening "offer" whose end coincides with a real segment's end is an early heads-up for that ad, not an intro skip.
    const real = cands.filter((c) => !c.offerOnly && c.end != null && c.confidence >= 0.6);
    const list = cands.filter((c) => !(c.offerOnly && c.end != null && real.some((r) => Math.abs(r.end - c.end) <= 20)));
    const sorted = list.sort((a, b) => a.start - b.start || b.confidence - a.confidence);
    const out = [];
    for (const c of sorted) {
      const cEnd = c.end == null ? c.start + 1 : c.end;
      let hit = -1;
      for (let i = 0; i < out.length; i++) {
        const o = out[i], oEnd = o.end == null ? o.start + 1 : o.end;
        if (U.overlap(o.start, oEnd, c.start, cEnd) > 0 || (c.start >= o.start && c.start < oEnd)) { hit = i; break; }
      }
      if (hit < 0) { out.push(Object.assign({}, c)); continue; }
      const o = out[hit];
      if (!!o.offerOnly !== !!c.offerOnly) {                      // offers and real segments never merge: keep the real one
        if (!c.offerOnly) out[hit] = Object.assign({}, c);
        continue;
      }
      if (c.confidence > o.confidence) {
        const both = o.confidence >= 0.6 && o.end != null && c.end != null;
        const n = Object.assign({}, c);
        if (both) { n.start = Math.min(o.start, c.start); n.end = Math.max(o.end, c.end); }
        out[hit] = n;
      } else if (c.confidence >= 0.6 && o.end != null && c.end != null) { o.start = Math.min(o.start, c.start); o.end = Math.max(o.end, c.end); }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // ---------- exports ----------
  const PATTERNS = {
    jump: { label: '空降 / 跳转提示', source: P.jump.source },
    announce: { label: '广告开始提示', source: P.announce.source },
    moment: { label: '时机提示（弱）', source: P.moment.source },
    sponsor: { label: '恰饭 / 金主玩梗', source: P.sponsor.source },
    bare: { label: '裸词（广告 / 恰）', source: P.bare.source },
    weak: { label: '弱提示', source: P.weak.source },
    negation: { label: '否定 / 疑问 / 泛谈（忽略）', source: P.negation.source },
    endStrong: { label: '广告结束（强）', source: P.endStrong.source },
    endMedium: { label: '广告结束（弱）', source: P.endMedium.source },
    endNegation: { label: '结束词例外', source: P.endNegation.source },
    poi: { label: '省流 / 高能跳转（仅提示）', source: P.poi.source },
  };
  detectDanmaku.classify = (text, t, duration, action) => classify(text, +t || 0, +duration || 0, action, null);
  detectDanmaku.PATTERNS = PATTERNS;
  BAS.detectDanmaku = detectDanmaku;
})();
