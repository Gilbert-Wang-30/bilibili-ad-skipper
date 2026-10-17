# Bilibili Ad Skipper（恰饭跳过）

A Chrome (Manifest V3) extension that detects and skips in-video sponsored segments (恰饭 / 植入广告) on
`www.bilibili.com/video/*`. Everything runs locally in your browser: no server of its own, no accounts, no telemetry.

> Unofficial project, not affiliated with bilibili. Released under the MIT license.

## How it detects an ad

Five independent signals are fused into time segments with a confidence score:

| Signal | What it uses | Confidence |
|---|---|---|
| **Chapters (章节 / 视频看点)** | Uploader chapters from the player API whose title says 广告 / 恰饭 / 赞助 / 推广 / 商单 … | 0.95 |
| **Danmaku (弹幕)** | All danmaku of the video (same protobuf API the player uses). Clusters of *ad announcements* (恰饭了, 广告来了, 零帧起手, 感谢金主…), *jump cues* (空降 6:00, 跳伞04:50, 745工程, 坐标609, 向右20下 …) and *landing thanks* (欢迎回来, 空降成功, 感谢609工程 …). The median of agreeing jump targets gives the end; thanks clusters confirm it. | 0.2 – 1.0 |
| **Viewer heat (高能进度条)** | The player's own viewer-activity curve (about 100 samples per video, served without login). When many viewers drag past an ad, the curve ramps up across it, peaks at its end and falls off a cliff. A danmaku segment that matches gets +0.2 confidence, which lets thin danmaku (e.g. signed out) still auto-skip. On popular videos it also blocks auto-skips that have no 空降 coordinates when the curve shows no skipping. Alone, it only offers a manual skip button. | confirmation |
| **Audio / video look-ahead** | For every suspected segment, *before you reach it*, the extension downloads just that stretch (plus 45 s around it) of the video's own lowest-bitrate audio track and its 360p picture, using the byte index every bilibili stream carries (about 2–5 MB per segment), decodes it in the page (`decodeAudioData`, WebCodecs) and compares the inside with the surroundings. Sponsored reads are **louder**, their loudness is **steadier** (narration over music, no pauses), and they are usually **brighter**; ordinary content is not. A segment that does not look like an ad is never auto-skipped, one that does gets +0.25 confidence, and its end is moved to the real transition (a short silence together with a hard cut). It also finds the end for danmaku that only announce an ad's start. | confirmation, veto, boundaries |
| **Live frame cuts** | While the video plays, low-resolution frame differences (and optionally the audio level/spectrum via `captureStream`, never re-routing playback) record hard cuts. Cuts within a few seconds of a boundary that the look-ahead did not already fix snap it to the exact frame. | refinement only |

Rules that keep false positives down (all learned from 50 real videos, see `test/fixtures/expected.json`):

* A segment is **auto-skipped only when confidence ≥ 0.6** (configurable). That requires either ≥ 3 viewers agreeing on a landing time, or explicit ad vocabulary **plus** a strong end marker. A lone "跳伞23:36" or story words like 躲过一劫 never auto-skip.
* "打钱 / 商单 / 广子" jokes that are spread over a whole sponsored review, "开屏广告" discussions, "怎么还没广告" anticipation and other negations are ignored.
* Opening skips ("跳伞04:50" posted at 0:00, "正片2:00", "省流 跳转4:00") are shown as an **offer** (a skip button and a dashed marker) but never skipped automatically.
* Jump targets into the last 3 % of a video (at least 20 s) are ignored: those are "skip to the end" jokes or the outro, never an ad's end.
* Crowds also post coordinates for things that are not ads: a famous moment (名场面), the good part, the end of a boring
  stretch. The audio/video look-ahead checks every such segment; if the skipped stretch sounds and looks like the rest of
  the video it is kept as an offer only (`· 音视频不像广告` in the popup).

## Privacy

* The extension only talks to bilibili's own servers (`api.bilibili.com`, `bvc.bilivideo.com` and the video CDN the
  player itself streams from), making the same kind of requests the bilibili player makes. Nothing is sent anywhere
  else, and there is no analytics.
* The audio/video look-ahead fetches byte ranges of the video's own streams and analyses them in memory. No audio or
  picture is stored; only the verdict (a score and the refined boundaries) goes into the result cache. Turn it off with
  **音视频预读核验** in the options.
* Settings sync through `chrome.storage.sync`. Per-video ignores and a 12-hour result cache stay in `chrome.storage.local`.
* Host permissions are limited to `www.bilibili.com`, `api.bilibili.com` and `bvc.bilivideo.com` (the CDN answers the
  page's own range requests, so it needs no extra permission).

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder (`bilibili-ad-skipper`).
3. Open any bilibili video. Detected segments appear as coloured markers on the progress bar
   (orange = chapter, pink = danmaku, green = your own, striped = low confidence, dashed = offer only).

## Using it

* **Auto mode** (default): when playback enters an ad, it jumps to the end and shows a toast `已跳过广告 4:12 → 6:00` with **撤销**.
  Undo seeks back and remembers that segment as "not an ad" for this video. Ignored segments stay on the progress bar
  (dimmed) and in the popup with a **恢复** button.
* **Manual mode**: a **跳过广告 ▶** button appears instead; click it to skip.
* **Missed an ad?** Click the **⏭** button in the player's control bar (or 跳过正在播放的广告 in the popup) while the ad
  plays. It first analyses the next few minutes of the video's own audio and picture (a few seconds, toast
  `正在分析音视频…`) and jumps to the first transition that looks like the ad's end. Without that it uses everything
  around that moment, even evidence too weak to auto-skip on: segments shown but not skipped, 空降 coordinates posted
  near now, landing danmaku (欢迎回来 / 空降成功), the heat curve, the next chapter; if nothing is found it moves
  forward 30 s. The toast offers **撤销** and **记住** (save it as an ad for this video, so it is skipped automatically
  next time). On the measured ads, presses anywhere inside the ad land 2.1 s early … 0.2 s late.
* If you seek into a skipped segment yourself, it is not skipped again until you leave it.
* **Popup** (toolbar icon): on/off, mode, the list of segments (跳到此处 / 忽略), low-confidence candidates, manual marking
  (标记广告开始 / 结束), 重新检测, 清除本视频覆盖.
* **Options**: confidence threshold, which signals to use (incl. the audio/video look-ahead), live audio analysis (off by default), markers/toast, landing offset,
  extra keywords, ignored UP主 (mid or space link), debug logging, export/import.

Per-video overrides and a 12-hour result cache live in `chrome.storage.local`; settings sync via `chrome.storage.sync`.

## Project layout

```
manifest.json                 MV3 manifest (content scripts in load order, MAIN-world bridge)
src/page-bridge.js            MAIN world: page state (aid/bvid/cid/p) + observed player API responses → postMessage
src/content/00-ns.js          BAS namespace, utils (time parsing incl. 空降 formats), defaults
src/content/10-storage.js     settings / overrides / cache
src/content/20-protobuf.js    danmaku protobuf decoder
src/content/21-wbi.js         WBI signing (md5) for the signed API variants
src/content/22-api.js         view / player info / danmaku fetch (direct, with background fallback)
src/content/30-detect-chapters.js
src/content/31-detect-danmaku.js
src/content/32-media.js       frame/audio transition analyzer
src/content/34-detect-heat.js 高能进度条 heat curve: ad-shaped runs, confirmation, guard, offers
src/content/35-skip-here.js   "skip the ad playing now": end estimate for ads the detectors missed
src/content/36-media-probe.js look-ahead: DASH byte index (sidx), ranged fetch, fMP4 demux, audio/video decode, features
src/content/37-av-segment.js  look-ahead judgement: is it an ad, where does it end (pure, tested)
src/content/33-fusion.js      merge, snap, overrides → segments
src/content/40-skipper.js     timeupdate watcher, skip/undo/manual
src/content/41-ui.js + content.css   markers, toast, skip button
src/content/50-main.js        orchestrator + popup messaging
src/background.js             fetch proxy, badge
src/popup/, src/options/
test/                         Deno tests, real-danmaku fixtures, UI harness
tools/                        CDP helper to drive a scratch Chrome with the extension installed
```

## Development

Tests (no npm needed):

```bash
deno test --allow-read test/
```

The detector was tuned on danmaku from 50 public videos. That corpus is other people's comments, so it is **not**
included in this repository; tests that need it (`test/fixtures-full/`) are skipped automatically. The same goes for the
audio/video features measured from 18 stretches of those videos (`test/fixtures-full/av/`, numbers only). The ground truth
(`test/fixtures/expected.json`, frame-measured ad boundaries) and the heat curves (`test/fixtures/pbp.json`) are included.

Detector report over all fixtures (needs the private corpus):

```bash
deno run --allow-read test/report-danmaku.js
```

UI harness (bpx player mock): serve the folder (`python -m http.server 8766`) and open
`http://127.0.0.1:8766/test/harness/player-mock.html`.

Scratch browser with the extension installed through the DevTools protocol (Chrome 126+):

```bash
tools/launch-test-browser.sh https://www.bilibili.com/video/BV1jCJs6UE9S/
```

then `deno run -A tools/cdp.js console BV1jCJs6UE9S 20` to watch `[BAS]` logs, or `tools/cdp.js shot <tab> out.jpg`.

## Accuracy (measured)

The danmaku detector was checked against 50 real videos (19 verified to contain no ad) and 7 sponsored segments whose boundaries
were measured frame by frame:

| | result |
|---|---|
| Sponsored segments found with auto-skip confidence | 7 / 7 |
| Start error (estimate − real onset) | −1.6 … +2.7 s |
| End error | −0.5 … +2.2 s |
| Auto-skips on the 19 negative videos | 0 |
| Detection time per video (up to 77 000 danmaku) | 0.1 – 26 ms |
| Ads auto-skipped with 1/10 of the danmaku (like signed out), without → with heat | 5–6 / 6 → 6 / 6 |
| Ads auto-skipped with 1/20 of the danmaku, without → with heat | 1–3 / 6 → 3–5 / 6 |
| False auto-skips at reduced density, with heat | 0 |

Audio/video look-ahead (7 measured ads, 632 ad-length slices of ordinary content, a story skip, a benchmark skip and
three opening skips):

| | result |
|---|---|
| Measured ads confirmed, with the boundaries handed to it 2–6 s off | 7 / 7 |
| Ad end after refinement (real end − refined) | −2.1 … +0.2 s |
| Content slices confirmed as an ad | 0 / 632 (585 refuted, 47 undecided) |
| Story skip, benchmark skip, opening skips confirmed as an ad | 0 / 5 (story skip refuted) |
| Skip-button presses inside an ad: landing vs the real end | −2.1 … +0.2 s (35 presses) |
| Live check on bilibili (2026-10-17) | 7 / 7 ads auto-skipped, ends −2.1 … +0.2 s; the thin-danmaku ad that used to be offer-only is now skipped; story skip and opening skip refuted |
| Cost per suspected segment | 2–7 MB, 4–10 s in the background |

## Limitations

* Danmaku-based detection needs viewers to have reacted; very new or unpopular videos may have no usable danmaku.
  Logged-in users receive far more danmaku than anonymous ones.
* Starts come from crowd timing (the uploader usually segues into an ad while talking, so the picture and sound give
  no clean cut there): a skip can start up to ~3 s late or ~2 s early. Ends are measured from the media.
* The look-ahead was calibrated on 7 sponsored reads from four channels. An ad that is no louder, steadier or brighter
  than the video around it (e.g. a game sponsor shown with gameplay) is "undecided": it neither helps nor blocks.
* Only verified on a handful of channels' audiences (小约翰可汗, 半佛仙人, 极客湾, 影视飓风); other communities' conventions
  are parsed but untested.
* Only `www.bilibili.com/video/*` (plus `/list/*`, `/festival/*`) pages; bangumi/live are out of scope.
* Bilibili's own pre-roll/overlay ads are not touched.
