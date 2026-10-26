# Bilibili Ad Skipper — Engineering Spec (contract for all modules)

Chrome MV3 extension that detects and skips in-video sponsored segments (恰饭/植入广告) on
`https://www.bilibili.com/video/*` pages. No build step: plain scripts loaded in order by the manifest.

## 1. Verified facts about Bilibili (2026-10, measured in the real browser)

* Page globals (MAIN world only): `window.__INITIAL_STATE__` has `aid`, `bvid`, `cid`, `p`,
  `cidMap`, `videoData` (`cid`, `duration`, `title`, `owner.mid`, `pages[{cid,part,duration}]`),
  `upData.mid`. `window.player` exposes `seek(t)`, `getCurrentTime()`, `getDuration()`,
  `mediaElement()`, `on/off`, `getManifest()` (`{aid,cid,bvid,p}`), `toast`.
* `<video>` lives at `.bpx-player-video-wrap > video`, `crossOrigin="anonymous"`, `src` is an MSE
  `blob:` URL. `video.captureStream()` works (audio+video tracks live) and does NOT disturb playback.
  `canvas.drawImage(video)` + `getImageData` works (not tainted). `requestVideoFrameCallback` exists.
  The element can be replaced by the player (quality switch / new video) — always re-query.
* Player DOM (all inside `#bilibili-player .bpx-player-container`):
  * `.bpx-player-video-area` (position:relative, full video size). Children with z-index:
    `.bpx-player-control-wrap` z75, `.bpx-player-toast-wrap` z76, `.bpx-player-top-wrap` z70,
    `.bpx-player-new-dialogue-area` z999. Our overlay layer goes inside `.bpx-player-video-area` with z-index 74
    (below the control bar so its quality/speed popovers stay clickable, above the top title bar).
  * Progress: `.bpx-player-progress-area` > `.bpx-player-progress-wrap` > `.bpx-player-progress`
    (position:relative, height 4px, full width) whose children are
    `.bpx-player-progress-schedule-wrap`, `.bpx-player-progress-point-wrap`, `.bpx-player-progress-thumb`, …
    Markers go in a `div.bas-markers` inserted right before `.bpx-player-progress-thumb` inside `.bpx-player-progress`
    (absolute, inset 0, z-index auto → above the played fill, below the thumb). The progress bar is created lazily the
    first time the controls show, so the orchestrator re-checks every second (no MutationObserver: the danmaku layer
    mutates the player subtree constantly and repainting inside it would re-trigger the observer).
  * `.bpx-player-shadow-progress-area` (absolute, 2px high, shown when controls are hidden) — mirror markers there.
  * Control buttons use `.bpx-player-ctrl-btn` (36×22) inside `.bpx-player-control-bottom-right`.
* APIs (all work from page origin with cookies, `fetch(url, {credentials:'include'})`):
  * `GET https://api.bilibili.com/x/web-interface/view?bvid=BV…` → `data.{aid,cid,duration,title,owner{mid,name},pages[{cid,part,duration}]}`.
  * `GET https://api.bilibili.com/x/player/v2?aid=&cid=` and `x/player/wbi/v2` (works unsigned today) →
    `data.view_points: [{type, from, to, content, imgUrl, logoUrl}]` (uploader chapters; empty array when none).
  * `GET https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&pid={aid}&segment_index={n}` →
    `application/octet-stream` protobuf `DmSegMobileReply { repeated DanmakuElem elems = 1 }`.
    Each segment covers 360 000 ms; n = 1..ceil(duration/360). Logged-in users get far more danmaku
    (650 KB vs 29 KB for anonymous), so the request must carry the user's cookies.
  * `DanmakuElem` fields: 1 id(int64) 2 progress(int32, ms — ABSENT when 0) 3 mode 4 fontsize 5 color
    6 midHash(string) 7 content(string) 8 ctime 9 weight 10 action(string) 11 pool 12 idStr 13 attr.
    `action` examples seen: `airborne:290000` (空降 target in ms; content was "跳伞04:50"),
    `picture:i0.hdslb.com/…png` (emoji — ignore). Protobuf default values are omitted → default progress to 0.
  * Anonymous (no cookie) requests from outside the browser get HTTP 412. Not our concern in-extension.
* Content scripts' `fetch` is subject to page CORS; api.bilibili.com allows `*.bilibili.com` origins with
  credentials, so direct fetch from the content script works. Background fetch (host_permissions) is the fallback.
* Media: `GET https://api.bilibili.com/x/player/wbi/playurl?bvid=&cid=&qn=16&fnval=4048&fnver=0&fourk=0` (WBI-signed) →
  `data.dash.{audio,video}[]` with `baseUrl`/`backupUrl`, `codecs` (`mp4a.40.2`; `av01.…`, `avc1.…`, `hev1.…`),
  `bandwidth`, `width/height` and `segment_base {initialization:'0-836', index_range:'837-6780'}`. Each stream is one
  fragmented MP4: init (moov) + a `sidx` listing ~5 s fragments (moof+mdat) with byte offsets. The upos CDN answers
  `Range` requests from the page origin with 206 and CORS, so any time window can be fetched without new permissions.
  The lowest audio is ~65 kbps (8 KB/s); 360p video is 125–400 kbps (AV1 cheapest, AVC dearest). Portrait videos list
  their streams in portrait pixels (360P = 360×640). `decodeAudioData` accepts init + fragments;
  WebCodecs `VideoDecoder` decodes AV1/AVC 360p at ~40× real time.

## 2. File layout

```
manifest.json
icons/16.png 32.png 48.png 128.png
src/background.js                 service worker: fetch proxy, defaults, badge
src/page-bridge.js                MAIN world: page state + fetch hooks → postMessage
src/content/00-ns.js              BAS namespace, constants, utils, event bus, DEFAULT_SETTINGS
src/content/10-storage.js         settings + per-video overrides + result cache
src/content/20-protobuf.js        BAS.decodeDmSeg(ArrayBuffer|Uint8Array) → Danmaku[]
src/content/21-wbi.js             BAS.wbi.sign(params, imgKey, subKey) + md5
src/content/22-api.js             BAS.api.*
src/content/28-detect-subtitles.js BAS.detectSubtitles() (§7.9)
src/content/30-detect-chapters.js BAS.detectChapters()
src/content/31-detect-danmaku.js  BAS.detectDanmaku()
src/content/32-media.js           BAS.MediaAnalyzer
src/content/34-detect-heat.js     BAS.detectHeat (§7.5)
src/content/35-skip-here.js       BAS.findAdEnd (§7.6)
src/content/36-media-probe.js     BAS.mp4 / BAS.avFeatures (pure) + BAS.mediaProbe (network, decoders) (§7.7)
src/content/37-av-segment.js      BAS.avSegment (pure judgement) (§7.7)
src/content/33-fusion.js          BAS.fuse()
src/content/40-skipper.js         BAS.Skipper
src/content/41-ui.js              BAS.ui
src/content/50-main.js            orchestrator
src/content/content.css
src/popup/popup.html|js|css
src/options/options.html|js|css
test/                             deno tests + fixtures (see §10)
```

Every content module is a classic script: `(() => { const BAS = globalThis.BAS; … BAS.x = …; })();`
Modules 00–33 and 40 MUST NOT touch the DOM, `chrome.*` or `window.location` at load time (so they
can be loaded in Deno tests with a stub `globalThis`). Only define functions/classes at load.
`10-storage.js` may reference `chrome.storage` inside functions, guarded by `typeof chrome !== 'undefined'`.

## 3. Shared types (JSDoc, enforced by convention)

```js
/** @typedef {{t:number, text:string, action?:string, mode?:number, pool?:number, weight?:number}} Danmaku  // t in seconds */
/** @typedef {{type:number, from:number, to:number, content:string}} ViewPoint                       // seconds */
/**
 * @typedef Candidate
 * @prop {number} start      seconds
 * @prop {number|null} end   seconds; null = unknown end (fusion must resolve or drop)
 * @prop {'chapter'|'danmaku'|'media'|'user'} source
 * @prop {number} confidence 0..1
 * @prop {string} reason     short zh-CN explanation shown in UI, e.g. '章节「广告」', '弹幕 14 条 · 空降 3 条'
 * @prop {object} [evidence] free-form debug info
 * @prop {boolean} [offerOnly] true = never auto-skip even if confidence high (e.g. intro "跳伞" targets)
 */
/** @typedef {Candidate & {id:string, sources:string[], autoSkip:boolean, enabled:boolean}} Segment */
```

`BAS.DEFAULT_SETTINGS` (in 00-ns.js):

```js
{
  enabled: true,
  mode: 'auto',              // 'auto' | 'manual'  (manual = show a 跳过广告 button instead of auto skipping)
  minConfidence: 0.6,        // auto-skip threshold
  useChapters: true,
  useDanmaku: true,
  useMedia: true,            // video-frame cut detection for boundary snapping
  useAudio: false,           // experimental audio analysis via captureStream
  showMarkers: true,
  showToast: true,
  toastDurationMs: 6000,
  landingOffsetSec: 0,       // added to segment.end when seeking
  extraStartKeywords: [],    // user strings, matched as substrings
  extraEndKeywords: [],
  ignoreUps: [],             // array of mid (number|string) — do nothing on their videos
  debug: false,
}
```

## 4. Namespace & utils (00-ns.js)

```js
globalThis.BAS = {
  VERSION, DEFAULT_SETTINGS,
  log(...a), warn(...a), debug(...a)   // prefixed '[BAS]'; debug() prints only if BAS.state.settings.debug
  state: { settings: {...DEFAULT_SETTINGS} },
  util: {
    fmtTime(sec) → 'm:ss' or 'h:mm:ss',
    clamp(x,a,b), median(arr), mean(arr), sleep(ms), debounce(fn,ms), throttle(fn,ms),
    normalizeText(s)  // full-width → half-width (digits, ':', '：'), trim, lower-case latin, strip [emoji] tags
    parseTimeMention(text, duration) → number|null   // '4:50', '04：50', '1:02:03', '4分50秒', '4分50', '4分半' → seconds; reject > duration or 0
    overlap(a0,a1,b0,b1) → seconds of overlap
    uid() → string
  },
  events: tiny emitter { on(type, fn) → off, off, emit(type, payload) },
};
```

## 5. Storage (10-storage.js) — `BAS.storage`

* `loadSettings()` → merged `{...DEFAULT_SETTINGS, ...sync.settings}`; sets `BAS.state.settings`.
* `saveSettings(partial)`; `onSettingsChanged(fn)` (uses `chrome.storage.onChanged`).
* Per-video overrides in `chrome.storage.local` under key `v:${bvid}:${cid}`:
  `{ ignore: [{start,end}], add: [{start,end}], ts }` → `getOverrides(bvid,cid)`, `addIgnore(...)`, `addUser(...)`, `clearOverrides(...)`.
* Result cache `c:${cid}` → `{ segments, candidates, ts, version }`, TTL 12 h; `getCache(cid)`, `setCache(cid, data)`.
* Prune: keep ≤ 300 `c:` entries (LRU by ts) — run opportunistically in `setCache`.

## 6. API layer (20/21/22)

* `BAS.decodeDmSeg(buf)` → `Danmaku[]` (t = progress/1000, default 0; text = content; action only if non-empty; mode, pool, weight).
  Must be robust: skip unknown fields by wire type, never throw on truncated input (return what was parsed).
* `BAS.wbi`: `md5(str)` (pure JS), `getMixinKey(img,sub)`, `sign(params:Object, imgKey, subKey)` → query string including `wts` and `w_rid`.
  Keys from `x/web-interface/nav` (`data.wbi_img.img_url/sub_url` — the file name without extension). Cache keys 6 h in `chrome.storage.local` (`wbiKeys`).
* `BAS.api` (all return Promises; all accept `{signal}`; all use `BAS.api.fetchJSON/fetchBuffer` which try direct
  `fetch(url,{credentials:'include'})` first and fall back to background proxy message `{type:'BAS_FETCH', url, responseType}` on
  network/CORS error or HTTP 412):
  * `getView({bvid}|{aid})` → `{aid,bvid,cid,duration,title,owner:{mid,name},pages:[{cid,part,duration,page}]}`
  * `getPlayerInfo(aid,cid)` → `{view_points: ViewPoint[]}`; try `x/player/wbi/v2` unsigned, if `code !== 0` retry with wbi signature, then `x/player/v2`.
  * `getDanmaku(aid,cid,duration,{onSegment, preloaded})` → `Danmaku[]` sorted by t. Fetches segments 1..N with concurrency 3;
    `preloaded` is `Map<segmentIndex, Danmaku[]>` (from bridge hooks) to skip. On a failed segment, retry once then continue (never fail the whole call; report `missingSegments` via a property on the returned array: `result.missingSegments = [..]`).

## 7. Detectors

### 7.1 Chapters — `BAS.detectChapters(viewPoints, duration, settings)` → `{candidates: Candidate[], boundaries: number[]}`

* `boundaries` = sorted unique `from`/`to` values (0 and duration excluded).
* Ad chapter regex (case-insensitive, after normalizeText):
  `/广告|恰饭|恰个饭|赞助|推广|商单|商务|商业(合作|推广)|合作(推广|伙伴)?|金主|品牌(时间|合作)|软广|硬广|植入|带货|sponsor|\bad\b|^ad$|恰烂钱|打钱|广子/`
  but NOT if the content matches `/无广告|没有广告|非广告|广告结束|正片/`.
* Candidate: `{start: from, end: to, source:'chapter', confidence: 0.95, reason: '章节「'+content+'」'}`; drop if `to - from < 3` or `> 600`.

### 7.2 Danmaku — `BAS.detectDanmaku(list, duration, settings)` → `{candidates: Candidate[], diagnostics}`

Input: `Danmaku[]` (t seconds, text, action). Must run in < 50 ms for 20 000 items (single pass + small clusters).

Step A — classify each danmaku (after `normalizeText`):
* `target`: absolute time from `action` (`airborne:<ms>`; treat the value as ms when `v/1000 <= duration`, else as seconds when `v <= duration`, else ignore) or from `parseTimeMention(text)` when the text also contains a jump cue (`空降|跳伞|跳|指路|坐标|快进|正片|直达|传送|到`), or when the text is just a bare time (`/^\s*\d{1,2}[:：]\d{2}\s*$/`). Keep only targets with `target > t + 5` and `target - t <= 600`.
* `start` with weight: strong (1.0) = `恰饭|恰个饭|开始恰|广告(来|时间|开始|预警|警告|了|时间到)|广子|商单|插播|软广|硬广|金主|赞助|推广|打钱|恰烂钱|带货|前方(广告|恰饭)|注意(广告|恰饭)|该恰|恰了|恰上了|空降|跳伞|指路|坐标|快进`;
  medium (0.6) = bare `广告` or `恰` with no negation/question; weak (0.3) = `\bad\b`, `钱到位`, `爸爸`, `甲方`.
  Negation / question suppression → weight 0 (do not count as start): text matches
  `/没有?广告|无广告|不是广告|没恰|不恰|哪有|怎么(还)?没|还没(到|有)?|终于没|不会有|会不会有|是不是|有没有|吗[?？]*$|[?？]{1,}$|广告位|等广告|看广告|广告都|比广告|像广告|广告片|广告牌|广告法|广告词|广告费|打广告|做广告|拍广告|接广告|广告商|恰饭视频|恰饭的/` — note "怎么还没到广告" / "不会有广告吧" are anticipations and must not fire.
  Danmaku containing both a `start` cue and a `target` counts as start weight 1.0 AND as a target.
* `end` with weight: strong (1.0) = `空降成功|成功(空降|着陆|降落|落地)|安全(着陆|降落|落地)|着陆|落地|降落|感谢(空降|指路|提醒|前面|前排|楼上|大哥|大佬|好心人)|谢谢(指路|提醒|空降)|广告(结束|完了|没了|过了)|恰饭(结束|完了)|正片(开始|来了)|回来了|躲过|跳过了|错过了|已跳|逃过`;
  medium (0.5) = `感谢|谢谢|多谢|thx|3q|结束了|好了|可以看了|回来`.
* Also compute `density[]` per 5 s (all danmaku) for diagnostics.

Step B — start clusters: sort start-type items (weight>0) by t; greedy cluster with gap ≤ 12 s; cluster weight = Σweights
(+1.0 per distinct target posted inside the cluster window). Accept when weight ≥ `START_MIN` (default 3.0) or (targets ≥ 2 and weight ≥ 1.5).
Start estimate `ts = max(0, firstStrong.t - 3)` where firstStrong = earliest item with weight ≥ 0.6 in the cluster (fallback: earliest item).
If `ts < 5` (cluster at the very beginning) the segment is an *intro/opening* reference, not an in-video ad: mark `offerOnly: true`, confidence ≤ 0.5.

Step C — end estimate for each start cluster (search window `(ts+8, ts+300]`, clipped to duration):
1. `targets`: all targets whose posting time is in `[ts-10, ts+120]` and whose value is in the window. Cluster targets with ±10 s tolerance; take the largest cluster; `teTarget = median(cluster)`, `nTarget = size`.
2. `thanks`: end-type items in the window; greedy clusters with gap ≤ 10 s; score = Σweights; choose the first cluster with score ≥ 1.5 (or ≥ 1.0 if it contains a strong one). `teThanks = cluster.first.t - 2`.
3. Decide: both present and `|teTarget − teThanks| ≤ 20` → `end = teTarget`, agreement bonus. Both present but disagree → pick the one with more evidence (nTarget vs thanks score); confidence penalty. Only one → use it. Neither → `end = null`.
4. Sanity: `end - ts` must be in `[8, 300]`, else `end = null`.

Step D — confidence model (0..1). Compute per candidate:
* `targetsAgree` = number of target-bearing danmaku (posted in `[ts−10, ts+120]`) whose target lies within ±15 s of the chosen end.
* `adVocab` = Σ weights of *announcement / sponsor* items (NOT jump cues) within `[ts−10, ts+60]` — e.g. 恰饭, 广告来了, 零帧起手, 恭喜接单, 有广, 金主, 广子, 甲方, 商单, 打钱.
* `strongEnd` = count of strong end markers in the end cluster; `mediumEnd` = count of medium ones.

```
conf = 0.20
     + min(0.35, 0.08 * targetsAgree)             // 3 → 0.24, 5+ → 0.35
     + min(0.25, 0.08 * adVocab)                  // ~3 strong words → 0.24
     + (strongEnd ≥ 1 ? 0.20 : mediumEnd ≥ 1 ? 0.08 : 0)
     + (targetsAgree ≥ 2 && strongEnd ≥ 1 && |teTarget − teThanks| ≤ 15 ? 0.10 : 0)
     − (divergent targets ? 0.15 : 0) − (chatty video ? 0.10 : 0)
caps: end === null → ≤ 0.45; end from medium thanks only (no targets, no strongEnd) → ≤ 0.55;
      targetsAgree < 3 && adVocab < 1.5 → ≤ 0.55   (a lone "跳伞23:36" + story words like 躲过一劫 must not auto-skip)
      offerOnly → ≤ 0.50
```
Worked checks (must hold in tests): BV1jCJs6UE9S ≈ 0.95, BV1WhaA6hE7s ≈ 1.0, BV1Cgpd6pEBR ≈ 0.95, BV1y5gP61E6m ≥ 0.75, BV11NV86tEjW ≥ 0.65;
BV1xdNt6TEP3 1195–1416 ≤ 0.55 (1 target, no ad vocab — viewers skipped a story section, verified not an ad), BV1fHaB6WEh1 750–779 ≤ 0.55 (2 "跳过13:00" targets, benchmark charts, not an ad),
BV1T7411W7ca 755+ ≤ 0.55, BV1eZ4y1j7kw 109–157 ≤ 0.55.

End-marker exclusions: `感谢|谢谢` followed by `金主|甲方|老板|爸爸|妈妈|催更|赞助|品牌` is *sponsor vocabulary* (start side, weight 0.5), **not** an end marker;
but `感谢|谢谢` followed by a landing number (`感谢609工程`, `感谢空警600`, `谢谢810`) or by `空降|指路|提醒|前排|楼上|大哥|好心人` IS a strong end marker.

**Bare numbers are NOT targets.** Verified false positives: `220V的电` / `250的电工` / `360` (BV1VV5T6mEXM), `300s更新` / `x300p` (BV1Ebho6BE2J), `CR400AF-Z` (BV1A2bi6UEev) were parsed as 2:20 / 2:50 / 3:00 / 4:00 and produced 55 "agreeing" targets. A 3–4 digit number counts only when it carries a landing-meme suffix/prefix (`工程|航班|号登机口|号列车|高地|分局|项目|坐标|工程师?` — e.g. `812工程`, `0812航班`, `609高地`, `中情局608分局`), or when the same danmaku has an explicit jump word (空降|跳伞|坐标|指路|直达|传送|快进|跳到|空投|降落). Never when followed by a unit or product-ish token (`v|w|p|s|k|g|hz|fps|mah|元|块|年|月|日|次|个|条|人|万|%|度|寸|mm|cm|nm|gb|tb|版|代|型`) or preceded by a letter (`x300`, `cr400`).

Jump-cue number formats seen live (all → m:ss, posted at the ad start; parse Chinese numerals 零〇一二三四五六七八九 and 洞幺两拐勾): `812工程`, `0812航班`, `812号登机口`, `0558号列车`, `八一二工程`,
`4；50`, `4.49`, `3:00~4:50.` (take the last time), `东方812`, `P44`/`射击距离449` (take 3–4 digit numbers when ≥ 2 other danmaku within 15 s agree), relative `向右20下`, `PC端向右20下`, `右20下`, `往→17下`, `16下` (= 5 s per press).

Step D2 — rules learned from 50 real videos (test/fixtures-full), all MUST be implemented:
* **Weights by phrase class.** Explicit *jump cues* are the strongest start evidence: `空降|跳伞|坐标|指路|仙人指路|快进到|跳到|正片在|直达`
  (1.0) and any danmaku carrying a target. Explicit *ad announcements* `恰饭(了|时间|开始)?|广告(来了|时间|开始|预警|警告)|无缝插播|插播|前方(广告|恰饭)|该恰饭了|恰上了|软广|硬广` (1.0).
  *Sponsor-joke phrases* are weaker because viewers spam them anywhere a product is praised: `打钱|金主|甲方|赞助|商单|广子|恰烂钱|带货|推广|爸爸` = 0.5,
  bare `广告`/`恰` = 0.4, `\bad\b` = 0.3.
* **Negation / speculation suppression (weight 0):** in addition to the list above, suppress when the text contains
  `开屏|弹窗|插屏|贴片|广告拦截|广告位|坐标轴|坐标系|以为|怀疑|感觉|应该不是|希望|像是|像广告|不像|真不少|这么多|少点|又是|都是|期期|天天|全是|整个视频|整期|全程`
  (phrases that talk about ads in general or about the whole video being sponsored, not about a segment starting now).
* **Intro chatter rule:** a start cluster whose `ts < 5` and which carries **no targets** is viewers discussing the video as a whole → drop it entirely.
  A start cluster with `ts < 5` and targets (e.g. "跳伞04:50" ×7 at t=0, "正片2:00") is an *opening skip offer*: `offerOnly:true`, `start = 0`, `end = median target`, confidence 0.5.
* **Divergent targets:** if the largest target cluster holds < 50 % of all targets in the window (people disagree, e.g. 4:30 / 5:52 / 6:09), confidence −0.15.
* **Landing-time memes count as end markers AND targets:** `(\d)(\d{2})工程` / `(\d{3,4})工程` (e.g. `745工程` = 7:45, `600工程` = 6:00), `空警600`, and `谢谢\s*(\d{3,4})` → parse as m:ss (require ss < 60).
  Treat `欢迎回来|回来了|已穿越|成功穿越|穿越成功|躲过一劫|逃过一劫|感谢.{0,6}工程` as strong end markers (1.0).
* **Sponsor-announcement rule (critical):** some UPs mention the sponsor early ("这期有赞助商", "感谢金主催更" near 1:46) and the real ad comes minutes later.
  If, between a start cluster and the end it picked, another start cluster of weight ≥ 3 begins (≥ 20 s later), the first cluster's end is invalid → set `end = null` for the first cluster (it will be dropped) and keep the later cluster.
  Likewise an END cluster that starts within 10 s of an accepted START cluster is not an end (people post 空降 and thanks together at the ad start).
* **Window for 空降 danmaku:** jump cues are posted from ~10 s before the ad to ~60 s into it; thanks are posted 0–30 s after landing. See **Start time** below for the calibrated estimate.
* **Long ads exist** (UP skits up to ~220 s). Keep the 300 s cap but do not penalise length between 20 and 240 s.
* **Whole-video sponsorship** (e.g. 76 start items spread over a 9 min video) must yield nothing with `autoSkip`: the chatty-video penalty applies when start items / total danmaku > 1.5 % AND no cluster has targets.

* **Numeric landing memes as jump cues (critical for 小约翰可汗-style audiences):** at the ad start viewers post the *landing time as digits*:
  `710工程` ×13 at t≈340 (ad 340→430), `745工程`/`746工程`/`07:45`/`现在是7点46分` at t≈358 (ad 358→465), `坐标609`, `星语庭坐标 449`, `折跃坐标洞四五洞`
  (洞=0, 幺=1, 两=2, 拐=7, 勾=9 → "0450" = 4:50), `右17` / `→右19下` (press → 19 times = 19×5 s relative: target = t + n×5).
  Parse: `(\d)(\d{2})\s*(工程|号|型)?` and bare `\d{1,2}[:.：]\d{2}` → m:ss when ss<60 and the value lies in `(t+5, t+600]`;
  `(\d{1,2})点(\d{2})分?` → m:ss; `(\d+)(秒|s)后?` with 跳/快进 → relative. A bare number only counts when ≥ 2 danmaku within 15 s agree (±10 s) on the same target, to avoid picking up years/prices.
  Phrases that mark the exact ad start (weight 1.0): `零帧起手|丝滑衔接|突然变奏|恭喜接单|恭喜接广|来了来了|要来力|前奏|无缝衔接|无缝切换|变奏|开始了|可以关视频了|润物细无声`.
* **Strong-end requirement for auto-skip:** a candidate whose end comes only from *medium* thanks (bare 谢谢/好了/回来) is capped at confidence 0.55 — it is shown as a marker but never auto-skipped.
  Only targets (≥ 2 agreeing) or a strong end marker (`欢迎回来|空降成功|着陆|落地|穿越|工程|躲过|逃过|回来了|正片开始|广告结束|恰饭结束`) can push confidence ≥ 0.6.
  Reason: in 【半佛】瑞幸 (BV1T7411W7ca) viewers spam "我怀疑这是一个广告/作者在恰饭" from 755 s to the end while no ad exists.
* **Start time (calibrated 2026-10-13 on 7 ads measured frame by frame):** `ts = median(first ≤ 20 jump cues) + 2 s` (error −1.6 … +2.7 s; the earliest cue is 8–18 s early because of a sparse pre-wave). Without coordinates: `ts = first explicit announcement − 1 s` (announcements lag the onset by −2 … +3 s, median ≈ 0). Errors should lean late: showing a second of ad is better than cutting content. Never earlier than the previous accepted segment's end.
* **Pattern hygiene (from the adversarial review):** generic surprise phrases (猝不及防/画风突变/触发连招) are 0.5 'moment' words, not announcements; `有广` counts only as `有广无币` or at the end of a text; `没有广`, `看完广告了`, `跳过广告了`, `接不到广告` are negations. Number-bearing landing markers (`谢谢810`, `我是710工程`, `感谢七分十五郎`) are strong only when the number is a valid m:ss near the posting time; `谢谢666` is not. Spec notation (`16+512`) and comparisons (`8>6`) are never targets.

Ground truth verified by watching the frames (see test/fixtures/expected.json): BV1jCJs6UE9S ad = 252–360 (空降6:00 ×5 at 254, "欢迎回来"/"感谢空警600" at 359);
BV11NV86tEjW ad ≈ 258–369 (坐标609 at 261); BV1WhaA6hE7s ad ≈ 340–429 (710工程 ×13 at 340–345, 欢迎回来 at 429); BV1gGgk6hEU8 ad ≈ 358–464 (745/746工程 burst at 358–362, 欢迎回来 at 464).
Negative: BV1T7411W7ca has NO ad although 44 "广告/恰饭/打钱" danmaku appear 755–880 s.

Step E — merge overlapping candidates (keep the higher confidence, union the range), sort by start. `reason` example:
`'弹幕 ' + nStartItems + ' 条 · 空降 ' + nTarget + ' 条 · 感谢 ' + nThanks + ' 条'`.
`evidence = {startItems:[{t,text}], targets:[{t,text,target}], thanks:[{t,text}], ts, teTarget, teThanks}` (cap each list at 30 entries).

`settings.extraStartKeywords/extraEndKeywords` are added as strong patterns (escaped substrings).

### 7.3 Media — `new BAS.MediaAnalyzer(video, {audio:boolean, onCut(cut)})`

* Samples only while `!video.paused && !video.ended`; video via `requestVideoFrameCallback` throttled to ≤ 5 fps (fallback `setInterval` 200 ms).
* Frame features: draw to 32×18 canvas (`willReadFrequently`), gray = (r+g+b)/3; `mad` = mean |Δgray| vs previous frame (0..255),
  `hist` = 16-bin luminance histogram L1 distance (0..2), `mean` luminance. Cut when `mad > 40 && hist > 0.6` and `mad > 2.5 × rollingMedian(mad over last 3 s)`;
  black frame when `mean < 12`. Record `{t: video.currentTime, strength: 0..1, kind:'video'|'black'}`. Debounce: ≥ 0.4 s between cuts.
  Skip sampling right after a seek (1 s) to avoid a false cut.
* Audio (opt-in): `video.captureStream()` → `new MediaStream(audioTracks)` → `AudioContext.createMediaStreamSource` → `AnalyserNode` (fftSize 1024).
  Every 200 ms compute RMS dB and spectral centroid; keep 2 s history; audio change when `|dB_now − dB_2s_ago| ≥ 8` or centroid ratio ≥ 1.8, sustained for 2 consecutive samples.
  If `AudioContext.state === 'suspended'`, resume on the next `play`/`click`/`keydown` (once). Never call `createMediaElementSource`. Never mute or reroute.
* API: `cuts` (array sorted by t), `nearestCut(t, window)` → cut|null, `cutsBetween(a,b)`, `attach(video)` (re-attach when element changes), `stop()`.
  Memory: cap `cuts` at 2000 entries.

### 7.4 Fusion — `BAS.fuse({candidates, duration, boundaries, media, overrides, settings})` → `Segment[]`

1. Drop candidates from disabled sources (`useChapters`, `useDanmaku`).
2. Chapter candidates are authoritative: any danmaku candidate overlapping a chapter candidate (> 40 % of itself) is merged into it (sources += 'danmaku').
   Crowd marks (§7.8) are hosts the same way, for danmaku and subtitle candidates. Then each remaining subtitle read
   (§7.9) hosts the danmaku candidates overlapping it: absorbed without changing its edges, except a confident one
   (≥ minConfidence, not offer-only) with IoU ≥ 0.5, which widens it to the union (+0.05).
3. For danmaku candidates: snap `start` to the nearest chapter `boundary` within 10 s; else to the strongest `media.nearestCut(start, 4)`.
   Snap `end` similarly (boundary within 10 s, else cut within 4 s). If `end === null`: use the next chapter boundary after start if it is within 300 s (confidence 0.5), else drop the candidate (keep it in `diagnostics.dropped`).
   Edges with `lockStart` / `lockEnd` (measured by the A/V look-ahead, §7.7) are not snapped; ids use `idStart` / `idEnd`
   (the detector's own estimate) when present, so a refinement never changes a segment's id.
4. Apply overrides: `ignore` ranges remove any segment overlapping them (> 50 %); `add` ranges become `source:'user', confidence:1`.
5. Clip to `[0, duration − 1]`, drop `end − start < 5`, merge overlaps (union; max confidence; union sources), sort.
6. `id = source[0] + ':' + Math.round(start) + '-' + Math.round(end)`; `autoSkip = confidence ≥ settings.minConfidence && !offerOnly`; `enabled = true`.

### 7.5 Viewer heat — `BAS.detectHeat` (34-detect-heat.js)

Source: `GET https://bvc.bilivideo.com/pbp/data?aid=&cid=&bvid=&r=loader` with `credentials:'omit'` (the CORS headers
are only sent when `r=loader` is present, as the player does). Current response: `{modules:[{name:'pbp', params:{data:{
step_sec, events:{default:[…]}, debug:'{"event_count":…,"total_dm":…}'}}}]}`; ~99 samples, `step_sec ≈ duration/99`
(25 s for a 40-minute video). `event_count` is in the millions, i.e. viewer activity, not danmaku. The page bridge
captures the player's own request (`BAS_HEAT`), so normally no extra request is made. The two newest test videos had no
curve yet (`step_sec 0`).

Measured shape (6 frame-measured ads): value i covers ((i−1)·step, i·step]. An ad is a run of ≥ 3 hot samples
(≥ 2.5× the video median) that mostly rises (ramp ≥ 0.4), peaks in the sample containing the ad's end or one/two before
it, then drops ≥ 2.5×; the peak is only 1.2–1.5× the previous sample (a jump-to-highlight spike is ≥ 10×). Precision is
about half a sample, so heat never sets boundaries.

Use:
* **Confirm** (`corroborate`): a danmaku candidate whose end lies in [peakStart − step, peakEnd + step] of an ad-shaped run
  covering ≥ 40 % of it, and which has independent danmaku evidence (≥ 1 target, announcement or strong end), gets
  +0.2 confidence (cap 0.85, never lowered) and `sources += 'heat'`.
* **Guard**: on videos with ≥ 200 000 events, an auto-skip candidate with < 2 agreeing targets and no matching run is capped
  at `minConfidence − 0.05`.
* **Offer** (`offers`): a strict ad-shaped run (≥ 4 samples, ≥ 60 s, ramp ≥ 0.5, peak in the last two samples, cliff ≥ 3,
  ≥ 5× median, first ≤ 0.6× peak, not in the first 5 % of the video) not explained by any candidate becomes
  `{source:'heat', offerOnly:true, confidence:0.5}` from the second hot sample to the peak's end.
* Setting `useHeat` (default true). Evaluation (test/detect-heat.test.js, fixtures/pbp.json): full density unchanged
  (6/6, 0 false); 1/10 density 6/6 with heat (5–6/6 without); 1/20 density 3–5/6 (1–3/6 without); 0 false auto-skips.

### 7.6 Skip the ad playing now — `BAS.findAdEnd` (35-skip-here.js)

For ads the detectors missed. The viewer presses the control-bar ⏭ button (`.bas-ctrl-skip`, first child of
`.bpx-player-control-bottom-right`, setting `skipHereButton`) or the popup button (`BAS_SKIP_HERE`). Only the END is
needed, and weak evidence is acceptable because a human confirmed the ad. Order of trust: an existing segment/candidate
covering now (any confidence, incl. ignored/dropped) → ≥ 2 agreeing 空降 targets posted in [t−150, t+60] → landing-marker
cluster after now → heat ramp containing now (its peak end; a second press past the middle jumps half a sample further)
→ … the subtitle read containing now (§7.9 `readEndAt`; before heat) … → a single target → a chapter boundary ≤ 20 s
ahead (a farther one was a median 54 s past the ad's end) → +15 s. When results came from the cache, danmaku (with the
bridge's preloaded segments) and subtitles are loaded with a 2.5 s deadline; the press never waits longer.
Measured on 252 presses at ¼ / ½ / ¾ of crowd-labelled ads, within 3 s of the end: targets 92 %, landing markers 81 %,
subtitle read 54–82 %, heat 67 %, single target 50 %, blind step 21 %; all together 65 % (61 % without subtitles).
The toast offers 撤销 (seek back) and 记住 (store `[start estimate, end]` as a user segment). Measured: presses early /
mid / late in the 7 ads land within 10 s every time (16/21 within 3 s) at full density; with 1/10 of the danmaku 18/21
within 3 s; with heat only ±17 s.

When `skipHereMedia` is on (default off since 0.6.0: the wait was the main complaint, and on 124 crowd-labelled ads the
media end was within 3 s only 13 % of the time) and the press is not inside a known segment, the media after the press is analysed
first (`[t−25, t+130]`, then `[t+115, t+300]`, at most 10 s): the first transition with end-likeness ≥ 2.0 wins
(source `'av'`). Measured: 35 presses early/mid/late in the 7 ads land −2.1 … +0.2 s from the real end.

### 7.7 Audio/video look-ahead — `BAS.mediaProbe` (36) + `BAS.avSegment` (37)

**Probe.** `probe(info, t0, t1, {video, fps, signal})` gets the manifest (§1, cached 50 min per cid), the init + sidx of the
lowest-bitrate AAC track and of the cheapest ≤ 480p video track the browser's `VideoDecoder` supports, fetches the
fragments covering the window in one ranged request per track and decodes them: audio with `decodeAudioData` into a
16 kHz mono `OfflineAudioContext` (WebCodecs `AudioDecoder` fallback), video with a minimal fMP4 demuxer (moof/traf/
trun → samples) and `VideoDecoder` (back-pressure on the `dequeue` event; `setTimeout` is clamped in background tabs).
Features: audio every 0.25 s over a 0.5 s window (`db` RMS, spectral centroid / flatness / flux, zcr, 16 log-mel bands);
video ≤ 4 rows/s plus one at every hard cut, each frame drawn at 48×27 (`mean` luma, `std`, saturation, colourfulness,
edge density, 8-bin hue; `cut` = largest frame-to-frame mean |Δluma| since the previous row, `drift` = change vs the
previous row). Nothing is stored (`cache: 'no-store'`). A 190 s window costs 4.5–11 MB and 4–10 s.
Robustness: a ranged attempt counts only as an exact 206 of the requested length (a node that ignores Range is
skipped); each attempt must answer with headers within 8 s (3 s for skip-here) and finish within 15 s + 1 s per 64 KB,
then the next backup URL (a node that timed out moves to the back); every byte received counts against the budget;
a 403/404 is reported in preference to a backup's other error; a 403/404 (signed URLs expire and are bound to the client)
refreshes the manifest once and retries the failed tracks; audio is decoded in ≤ 30 s pieces (decodeAudioData holds its
input at 48 kHz stereo) with one fragment of overlap at each seam, and all channels are averaged; the video track is
chosen by its short side (≤ 480) so portrait videos keep their picture; `bytes` reports what was fetched.

**Judgement** (pure, 1 s blocks of `db`, `dbsd` (loudness spread within the second), `flux`, `luma`):
* `score(inside, outside) = z(db) − z(dbsd) + 0.3·clamp(z(luma), −1, 3) + 0.3·clamp(z(flux), −2, 2)` with z = Cohen's d.
  Segment score = inside `[s+2, e−2]` vs `[s−45, s−1] ∪ [e+1, e+45]`. Measured: 7 ads ≥ 1.79 with boundaries ±5 s off;
  ad-length (60–130 s) content slices ≤ 1.2 (p99 0.85); story skip −0.1, benchmark skip 0.0, intros ≤ 0.4.
* Verdict: `ad` when score ≥ 1.4 (≥ 60 s) or 2.2 (40–60 s), never below 40 s (a loud, steady 25 s passage of content
  scored 3.1; every measured ad is ≥ 60 s); `notAd` when ≤ 0.6 and ≥ 30 s;
  else `unsure`; `unknown` without data.
* Transition = a local audio minimum ≤ −26 dB and ≥ 9 dB under the ±5 s median, paired with a cut (`cut` > 30 or
  `drift` > 60) within 0.9 s (audio-only: the dip itself). Inside-ad transitions score < 1.2 on end-likeness, true ends
  ≥ 2.8, content transitions < 2.0 (0 / 138, p99 1.48).
* `refineEnd` (applied only to the end of an open-ended start; closed candidates keep their edges): best transition from
  8 s before to 1 s after the estimate whose 12 s before/after sides score ≥ 1.5, weighted by
  dip depth and cut strength minus a distance penalty. `refineStart`: only within [−0.5, +3] s of the estimate and side
  score ≥ 2.0 (segues hide the cut, and an earlier start would cut content).
* `findEnd(data, t)`: first transition after t − 3 (one the press has just passed is returned too; skip-here then
  reports the ad is over) whose end-likeness (inside `[max(t−20, p−60), p]` vs the 15 s after) is
  ≥ 2.0, best within 3 s of it; `{pending}` when the data ends first.
* `assessOpen(data, s)` for a danmaku start without an end: `findEnd(data, s + 20)` over `[s−45, s+260]`, then `assess`.
* `apply(candidates, results, settings)`: only an `ad` verdict acts. A candidate whose danmaku are ad-specific (ad vocabulary
  ≥ 0.4 or a landing-thanks end) gets +0.25 (cap 0.9, never for offers) and `sources += 'media'`. `notAd` / `unsure` are
  recorded in `evidence.av` only, and the edges of closed candidates are left as the detectors gave them. An open-ended
  danmaku start whose span is `ad` gets the A/V end (`lockEnd`, `idStart/idEnd`) and the boost if its danmaku are ad-specific.
  Measured on the BilibiliSponsorBlock set (README "Crowd-labelled test"):
  - The old `notAd` veto blocked 26 real ads for 1 control video; a third of the real ads judged were `notAd`.
  - Edge snapping changed as many ends for the worse as for the better.
  - Without the ad-specific rule, `ad` verdicts on intro/OP candidates (pure 空降 clusters) added control auto-skips.
  - Thresholds 1.2–1.4 gave the same +13 hits and no false ones; 1.0 added a false one.

**Orchestration.** After each fusion the orchestrator probes, one at a time in the background, up to 4 candidates per
video that are not yet past (auto-skip candidates first, then offers; spans ≤ 420 s; video only for windows ≤ 330 s).
Each result re-runs fusion and is cached with the detection results (`av: [[key, verdict]]`, current candidates only,
keeping the detection's own timestamp). A probe that fetched or decoded nothing is not a verdict: it is neither stored
nor cached (two such failures stop probing for that visit). Budget: 60 MB per video. The loop is tagged with its
detection run, stops when the run or the URL changes, and re-schedules itself for the new run. Setting `useAvProbe`
(default true).

Skip-here after any wait (danmaku download, A/V analysis): if the viewer seeked, navigated or the element changed,
nothing happens; if the measured end, or a real estimate (candidate / targets / thanks / heat / chapter), is already
behind the playhead, a toast says the ad is over; only the blind +15 s step is recomputed from the current position
(keeping the press-time start for 记住). The skipper judges suppressions (a segment the viewer chose to watch) by the segment's current range,
since A/V refinement can move edges under the same id.

End zone (detector R14): targets past `duration − max(8 s, 1 %)` are dropped ("skip to the end" jokes, also on the
airborne path); a danmaku segment ending after `duration − max(20 s, 3 %)` is capped at 0.55 (`evidence.endZone`, kept in
the cache). `BAS.avSegment.gate` runs after every boost (heat corroboration included) and caps such a segment at
`minConfidence − 0.05` unless its A/V verdict is `ad` with score ≥ 3 and its danmaku are ad-specific (a 2.55 'ad' was a
joke video's real ending).

Skipper suppressions after a refinement: a segment the viewer chose to watch (user seek / undo) is judged by its
current range; an auto-skip keeps the range it skipped, so an end that moved later is skipped as well.

### 7.8 Crowd marks — `BAS.detectCrowd` (39-detect-crowd.js), `BAS.api.getCrowdSegments` (22-api.js)

Source: BilibiliSponsorBlock (小电视空降助手). `GET https://bsbsb.top/api/skipSegments/<sha256(bvid)[0:4]>?categories=["sponsor"]`
returns `[{videoID, segments:[{segment:[s,e], cid, UUID, category, actionType, locked, votes, videoDuration}]}]` for every
marked video in the hash bucket (404 = none). Downvoted marks are hidden by the server; one segment per overlapping
cluster is returned.

Request path: the server sends no CORS headers, so the request always goes through the background worker. That worker's
allow-list admits only that path with a 4-hex prefix, sends no cookies and adds `x-ext-version`. Limits: 5 s timeout,
abort honoured, at most 50 segments read.

Mapping (pure):
* sponsor / skip only; votes ≤ −2 dropped; locked 0.98, votes ≥ 2 0.95, votes ≥ 0 0.9, votes −1 0.5 + `offerOnly`.
* A mark under another cid counts only on a single-part video of the same length (the file was replaced). A mark without
  a cid counts on a single-part video or by its length. A mark made on a cut of a different length (±3 s) is ignored.

Measured:
* The 7 frame-measured ads: all found live, start −3.4 … +1.6 s, end −0.6 … +1.8 s.
* The 19 verified ad-free videos: 0 marks.
* Unvoted submissions on videos with a confirmed ad overlap it 90 % of the time; downvoted ones 29 %.
* Coverage is the limit: about 1 in 10 current popular videos has a mark.

Fusion (§7.4 step 2): crowd marks are authoritative like chapters.
* A danmaku estimate overlapping > 40 % of itself merges in (+0.05 once).
* A weak or offer-only estimate that merely touches a mark is absorbed rather than unioned, so a mark is never stretched
  over content.

Elsewhere:
* The A/V look-ahead skips estimates a mark already decides.
* With `useCrowd` off, crowd candidates are ignored everywhere, the skip button included.
* A failed lookup keeps marks already known from the cache, and is never cached as "no marks".

### 7.9 AI subtitles — `BAS.detectSubtitles(lines, duration, settings)` (28-detect-subtitles.js) → `{candidates, rejected, lines}`

Input: the subtitle body `[{from, to, content}]`. Source (50-main.js `loadSubtitles`): the subtitle list in the player's
own `x/player/wbi/v2` response, forwarded by the bridge (`BAS_PLAYER_INFO.subtitles [{lan, url}]`, `signed`); the bridge
replays the last player infos on `BAS_REQUEST_STATE`, since the player asks before the content script listens. Waits up
to 4 s for it; no API call of its own. Track: `zh*`, then `ai-zh`, then English. File: `BAS.api.getSubtitleBody` —
only `https://(aisubtitle|i\d).hdslb.com/bfs/(ai_)?subtitle/…`, no cookies, 6 s timeout, ≤ 20 000 lines. A file whose last
line is past `duration + 5` or before `duration − max(60, 25 %)` (unsigned listing: `max(30, 10 %)`) is another video's
and is ignored. Setting `useSubtitles` (default true). A failed download keeps reads from the cache and is not cached.

Line vocabulary (weights from video-level frequency on 76 crowd-labelled transcripts): 3 = calls to action (链接, 置顶,
下单, 领券, 运费险, 保价 …, in the content of ≤ 1 video), 2 = shopping talk (评论区, 这款, 京东 …), 1 = common words that
only support. English: a few regexes (sponsored by, use code, link in the description …).

Algorithm:
1. Seeds: runs of weight-3 lines ≤ 90 s apart.
2. Product terms of a seed: 2–4-grams in ≥ 3 lines of `[c0 − 180, c1 + 40]`, at least one within `[c0 − 40, c1 + 20]`, at
   least one in a line with vocabulary, none elsewhere in the video; no function-character fragments, no number fragments,
   longest form kept.
3. Start: a line matching the opener pattern (本期的推广位 / 本期视频由…赞助 / 恰饭 …) inside the seed is the start;
   otherwise grow back ≤ 150 s over lines with vocabulary or a product term, gaps ≤ 20 s, stopping at an opener; then one
   segue line (说到 / 话说 / 对了 …) right before.
4. End: grow forward over lines with weight ≥ 2 or a product term, gaps ≤ 6 s.
5. Accept: ≥ 2 different weight-3 terms with (score ≥ 8 or a product term) and ≥ 3 lines → confidence 0.75 + 0.03 per extra
   term (+0.03 with a product term, ≤ 0.9); exactly one → needs a product term, score ≥ 8, ≥ 5 lines → 0.55 (offered).
   Length 12–300 s. Rejected regions are returned for the skip button.
6. More than 3 reads, or reads covering > 35 % of the video: all offer-only, ≤ 0.5 (a shopping video).

`readEndAt(lines, t, duration)`: the accepted or rejected read containing t → its end (`findAdEnd` source `subtitle`).
Following the talk forward without a read was measured worse than the blind step and is not done.

Measured (README "AI subtitles"): on the transcripts it was developed on, 46 % of labelled ad time, 33 s of content in 76
videos, start +2.7 s / end −2.1 s median vs the label; in the pipeline without crowd marks 22 % → 43 % of labelled ads
auto-skipped, 0 auto-skips on unlabeled content.

## 8. Skipper — `new BAS.Skipper(video, opts)`

`opts = { getSegments: () => Segment[], getSettings: () => settings, onSkip(seg, from), onEnter(seg), onLeave(seg) }`

* Listen to `timeupdate` + a 250 ms interval guard. For `t = video.currentTime`: find the enabled segment with `start ≤ t < end − 0.3`.
* Auto mode & `seg.autoSkip` & not suppressed → `video.currentTime = min(duration − 0.5, seg.end + landingOffsetSec)`; remember `{seg, from:t, at:Date.now()}`; `onSkip`.
  Suppression: a segment the user undid, or that the user *seeked into* manually (a `seeking` event whose target lies inside the segment and was not caused by us), stays suppressed until playback leaves it by > 2 s or a new video loads.
* Manual mode, or a segment with `!autoSkip` (low confidence / offerOnly): `onEnter(seg)` once per entry, `onLeave(seg)` when t leaves `[start, end)`; `skipNow(seg)` performs the seek.
* `undo()` → seek to `lastSkip.from`, suppress that segment. `attach(video)` to swap elements, `destroy()`.
* Must ignore `timeupdate` while `video.seeking`. Never seek when `video.readyState < 1`.

## 9. UI — `BAS.ui` (41-ui.js + content.css, all classes prefixed `bas-`)

* `mount(container /* .bpx-player-container */)` idempotent; `renderMarkers(segments, duration)` draws `div.bas-marker[data-id]` with
  `left = start/duration*100%`, `width = (end-start)/duration*100%`, color by source (chapter #ff7a45, danmaku #fb7299, user #52c41a, low-confidence striped/semi-transparent) in `.bpx-player-progress` and `.bpx-player-shadow-progress-area`;
  hovering a marker shows `title` = `'广告 ' + fmtTime(start) + ' - ' + fmtTime(end) + ' · ' + reason`.
* `showToast({html, actionLabel, onAction, durationMs})` top-right inside `.bpx-player-video-area` (z-index 80), stack ≤ 2, auto-hide, pause hide on hover.
* `showSkipButton({label:'跳过广告 ▶', sub:'1:23 → 2:45', onClick})` bottom-right above the control bar (like YouTube's), `hideSkipButton()`.
* `setBadge(count)` optional small indicator; `destroy()`; `refresh()` re-mounts if the player re-rendered (main calls it from its 1 s health check).
* Must not steal keyboard focus; buttons use `type="button"`, stopPropagation on click so the player does not toggle play.

## 10. Orchestrator (50-main.js)

1. Boot: `await BAS.storage.loadSettings()`; subscribe to changes; install bridge listener (`window.addEventListener('message', …)` filtering `e.source === window && e.data && e.data.__bas`).
2. Resolve current video identity: prefer bridge `BAS_PAGE_STATE`; fallback parse URL (`/video/(BV[0-9A-Za-z]{10}|av\d+)`, `?p=`) + `api.getView`.
   Identity key = `cid`. Re-run on: bridge state change, `popstate`, URL polling every 1 s (cheap), `<video>` element replacement.
3. Per video run (cancellable via AbortController):
   * if `settings.ignoreUps` contains mid → status `ignored`, clear UI, return.
   * cache hit (12 h, same `BAS.VERSION`) → use immediately, still refresh in background.
   * in parallel: `getPlayerInfo` → `detectChapters`; `getDanmaku` (with bridge-preloaded segments) → `detectDanmaku`;
     crowd lookup → `detectCrowd`; subtitles → `detectSubtitles`. One `[BAS] BV…: 章节 n · 众包 n · 字幕 … · 弹幕 N 条→k ·
     热度 有/无 → segments` console line per run.
   * 1.5 s after boot, a self-check (`BAS_PING` → background version / crowd permission; required modules present)
     shows a 20 s toast when Chrome still runs an older manifest than the files (unpacked extension not reloaded).
   * `fuse` → `segments`; `ui.renderMarkers`; `skipper` segments updated; cache; badge message to background `{type:'BAS_BADGE', count}`.
   * MediaAnalyzer attached if `useMedia||useAudio`; on each new cut within 6 s of any segment boundary → debounce 500 ms → re-`fuse` + re-render (do not re-run detectors).
   * A/V look-ahead of suspected segments in the background (§7.7); each verdict → re-`fuse` + re-render + cache.
4. Skip flow: `onSkip` → toast `'已跳过广告 ' + fmtTime(from) + ' → ' + fmtTime(seg.end) + '（' + reason + '）'` with action `撤销`; undo → `skipper.undo()` + `storage.addIgnore` (so a refresh respects it).
   `onEnter` (manual / low confidence) → `showSkipButton`; `onLeave` → hide.
5. Messages from popup (`chrome.runtime.onMessage`): `BAS_GET_STATE`, `BAS_SET_SEGMENT_ENABLED {id, enabled}`, `BAS_SEEK {t}`, `BAS_RESCAN`,
   `BAS_ADD_SEGMENT {start,end}`, `BAS_IGNORE_SEGMENT {id}`, `BAS_CLEAR_OVERRIDES`. Reply synchronously with the state object:
   `{ok:true, video:{bvid,cid,aid,title,duration,mid,upName,p}, status:'idle'|'loading'|'ready'|'error'|'ignored', error?, segments, dropped, settings, stats:{danmakuCount, viewPoints, cuts}}`.
6. Keyboard: none by default (avoid conflicts). Popup and skip button are the controls.

## 11. page-bridge.js (MAIN world, document_start)

* Hook `history.pushState/replaceState` + `popstate` → post `BAS_PAGE_STATE` (debounced 200 ms) built from `__INITIAL_STATE__` and `location`:
  `{aid, bvid, cid, p, duration, title, mid, upName, pages:[{cid,part,duration}]}` (cid for current p via `videoData.pages[p-1].cid`, fallback `__INITIAL_STATE__.cid`).
  Also post on `DOMContentLoaded`, on `BAS_REQUEST_STATE`, and poll `__INITIAL_STATE__.cid` every 1 s for changes (bilibili mutates state in place on part switch).
* Hook `window.fetch` and `XMLHttpRequest.prototype.open/send`: for URLs containing `/x/player/wbi/v2` or `/x/player/v2` post `BAS_PLAYER_INFO {aid,cid,view_points,subtitles:[{lan,url}],signed}` (kept for the last 5 cids and re-posted on `BAS_REQUEST_STATE`);
  for `/x/v2/dm/web/seg.so` or `/x/v2/dm/wbi/web/seg.so` post `BAS_DM_SEG {oid, segment_index, buffer}` (clone the Response and read `arrayBuffer()`; post with transfer list).
  Wrap everything in try/catch; never break the original call; never alter responses.
* Expose `window.__BAS_BRIDGE__ = {version}` for debugging. Message envelope: `{__bas:true, type, ...payload}` via `window.postMessage(msg, location.origin)`.

## 12. background.js

* `onInstalled`: write default settings if missing; open options on first install? (no — keep quiet).
* `onMessage`: `BAS_FETCH {url, responseType:'json'|'arraybuffer'}` → `fetch(url, {credentials:'include', headers:{Referer? not settable}})`; respond `{ok, status, json}` or `{ok, status, b64}`; only allow `https://api.bilibili.com/` URLs.
  `BAS_BADGE {count}` → `chrome.action.setBadgeText({tabId: sender.tab.id, text: count ? String(count) : ''})`, background color `#fb7299`.
* Keep service-worker friendly (no global state assumptions).

## 13. Popup / Options

Popup (zh-CN UI, 320 px wide): header with enable switch + mode select (自动跳过 / 手动按钮); current video title; status line; segments list
(`fmtTime(start) – fmtTime(end)`, source badge 章节/弹幕/手动, confidence %, buttons: 跳到此处, 忽略/启用); footer: 重新检测, 设置.
When no bilibili video tab is active: show hint. Use `chrome.tabs.query({active:true,currentWindow:true})` + `chrome.tabs.sendMessage`; handle "Receiving end does not exist" (show '请刷新页面').

Options: every setting in §3 with explanations, keyword textareas (one per line), ignoreUps textarea (mid 或 空间链接), 清除所有缓存/覆盖 buttons, export/import JSON. Save on change with a small "已保存" indicator.

## 14. Tests (Deno, no npm)

`deno test --allow-read test/` ; `test/load.js` creates `globalThis.BAS` by evaluating `src/content/00-ns.js, 20-protobuf.js, 21-wbi.js, 30-detect-chapters.js, 31-detect-danmaku.js, 33-fusion.js, 40-skipper.js` in order via `new Function(src)()` (with `globalThis.chrome` undefined).
Fixtures: `test/fixtures/<bvid>.json` = `{bvid, aid, cid, title, duration, owner, view_points, total, density5, dm:[[t,text] | [t,text,action]]}` (filtered real danmaku containing ad-related words + all airborne danmaku), plus `test/fixtures/expected.json` mapping bvid → expected segments `[{start,end,tolerance}]` or `[]` for ad-free videos. Detector tests assert each expected segment is matched within tolerance and that no extra auto-skip segment exists.

## 15. Non-goals / constraints

* No remote servers, no telemetry. Everything runs locally.
* Never modify bilibili's own requests/responses. Never block bilibili's own (pre-roll) ads system — out of scope.
* Must degrade gracefully: if any detector throws, log and continue with the others.
* All user-visible strings in Simplified Chinese.
