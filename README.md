# Bilibili Ad Skipper（恰饭跳过）

A Chrome (Manifest V3) extension that detects and skips in-video sponsored segments (恰饭 / 植入广告) on
`www.bilibili.com/video/*`. Its main detector reads the video's AI subtitles with a language model you choose (your own
API key, about $0.001 per video): it finds what the uploader says in a sponsored read, sentence by sentence. Without a
model it falls back to danmaku, crowd marks, the heat curve and keyword rules, which find roughly half the ads. There is
no server of its own, no accounts and no analytics; the requests that leave bilibili (the model you set up, the
crowd-mark lookup) are described under Privacy.

> Unofficial project, not affiliated with bilibili. Released under the MIT license.

## How it detects an ad

Up to eight signals are fused into time segments with a confidence score:

| Signal | What it uses | Confidence |
|---|---|---|
| **AI transcript check (AI 字幕分析, recommended)** | The video's AI subtitles (listed by the player, or by `x/v2/dm/view`, which also answers signed-out viewers) go to a language model of your choice with the title, as numbered lines. It answers with the first and last line of each sponsored read and quotes from both; the extension checks those quotes against the subtitles before using the answer. Edges are the subtitle sentences themselves. Uncertain reads, and videos that are commercial from start to end, are only offered. | 0.6 – 0.97 |
| **Chapters (章节 / 视频看点)** | Uploader chapters from the player API whose title says 广告 / 恰饭 / 赞助 / 推广 / 商单 … | 0.95 |
| **Crowd marks (小电视空降助手)** | Segments that viewers of [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) marked by hand and voted on (downvoted ones are hidden). Where a video has one it is the most precise signal (edges within ~1 s); a disputed mark is only offered. | 0.9 – 0.98 |
| **AI subtitles (AI 字幕)** | What the uploader says, from the AI subtitle file the player itself lists for signed-in viewers. A sponsor read ends in calls to action that ordinary talk almost never contains (链接 / 置顶 / 领券 / 下单 / 保价 / 运费险 …); the read is grown around them over lines that repeat the product's name (a term said there and nowhere else in the video), and starts at an announcement such as 本期的推广位. Edges land on sentence boundaries. Two different calls to action auto-skip; one is only offered. A video that sells from start to end (好物推荐) is only offered. | 0.55 – 0.9 |
| **Danmaku (弹幕)** | All danmaku of the video (same protobuf API the player uses). Clusters of *ad announcements* (恰饭了, 广告来了, 零帧起手, 感谢金主…), *jump cues* (空降 6:00, 跳伞04:50, 745工程, 坐标609, 向右20下 …) and *landing thanks* (欢迎回来, 空降成功, 感谢609工程 …). The median of agreeing jump targets gives the end; thanks clusters confirm it. | 0.2 – 1.0 |
| **Viewer heat (高能进度条)** | The player's own viewer-activity curve (about 100 samples per video, served without login). When many viewers drag past an ad, the curve ramps up across it, peaks at its end and falls off a cliff. A danmaku segment that matches gets +0.2 confidence, which lets thin danmaku (e.g. signed out) still auto-skip. On popular videos it also blocks auto-skips that have no 空降 coordinates when the curve shows no skipping. Alone, it only offers a manual skip button. | confirmation |
| **Audio / video look-ahead** | For a likely ad the danmaku cannot confirm on their own (they name an ad but are too few), *before you reach it*, the extension downloads just that stretch (plus 45 s around it) of the video's own lowest-bitrate audio track and its 360p picture, using the byte index every bilibili stream carries (about 4–12 MB per segment, at most 60 MB per video), decodes it in the page (`decodeAudioData`, WebCodecs) and compares the inside with the surroundings. Many sponsored reads are **louder**, **steadier** (narration over music, no pauses) and **brighter** than the video around them. When a segment clearly is, and its danmaku name an ad (恰饭 / 广告 … or landing thanks), it gets +0.25 confidence. That lifts thin-danmaku ads to auto-skip. It also finds the end for danmaku that only announce an ad's start. It never blocks a segment: on crowd-labelled ads a third of the real ones looked no different from their surroundings. | confirmation, open-ended ends |
| **Live frame cuts** | While the video plays, low-resolution frame differences (and optionally the audio level/spectrum via `captureStream`, never re-routing playback) record hard cuts. Cuts within a few seconds of a boundary that the look-ahead did not already fix snap it to the exact frame. | refinement only |

Rules that keep false positives down (all learned from 50 real videos, see `test/fixtures/expected.json`):

* A segment is **auto-skipped only when confidence ≥ 0.6** (configurable). That requires either ≥ 3 viewers agreeing on a landing time, or explicit ad vocabulary **plus** a strong end marker. A lone "跳伞23:36" or story words like 躲过一劫 never auto-skip.
* "打钱 / 商单 / 广子" jokes that are spread over a whole sponsored review, "开屏广告" discussions, "怎么还没广告" anticipation and other negations are ignored.
* Opening skips ("跳伞04:50" posted at 0:00, "正片2:00", "省流 跳转4:00") are shown as an **offer** (a skip button and a dashed marker) but never skipped automatically.
* Jump targets into the very end of a video (the last 1 %, at least 8 s) are ignored: those are "skip to the end"
  jokes. A segment that ends in the last 3 % (at least 20 s) may be an ad before a short outro, or a joke. It is only
  skipped automatically when the audio/video check strongly confirms it and its danmaku name an ad.
* Crowds also post coordinates for things that are not ads: a famous moment (名场面), the good part, an intro or OP song.
  Bare coordinates never get the audio/video boost (intros look and sound like ads to it), so such a cluster needs the
  same agreement as before to auto-skip. On 374 crowd-labelled videos no auto-skip landed on content nobody had marked.

## Privacy

* Detection talks to bilibili's own servers (`api.bilibili.com`, `bvc.bilivideo.com` and the video CDN the player itself
  streams from), making the same kind of requests the bilibili player makes. There is no analytics.
* **AI transcript check (off until you set up a model in the options).** For each video with AI subtitles, the
  background worker sends the video title and the full subtitle text to the model service you chose (Anthropic,
  DeepSeek, Alibaba Qwen, Zhipu GLM, OpenAI, Google Gemini, or your own OpenAI-compatible server such as Ollama), with
  your API key. That service therefore learns which videos you watch and processes the text under its own privacy
  policy. Nothing else is sent: no cookies, no bilibili account data. The key is stored only in the extension's own
  IndexedDB, which web pages and content scripts cannot open (not synced, not exported), and is sent only over https (or
  to your own machine). The extension asks for permission to reach that one service when you save, and gives back the
  permission of a service you stop using. Answers are cached for 60 days, so a video is analysed once; 删除 AI 设置
  removes the key, the permission and those cached answers. To stop runaway spending (a bug, or a script on a page
  forging new videos), the background worker sends at most 2 requests at a time, 60 an hour and 400 a day.
* **AI subtitles.** The list of subtitle files is read from the player's own `x/player/wbi/v2` response. When it has
  none (signed out, or the player's request was missed) the extension asks `x/v2/dm/view` once. The chosen file
  (Chinese first, then English) is downloaded once per video from bilibili's subtitle CDN (`aisubtitle.hdslb.com`),
  without cookies, as the player does when subtitles are turned on.
* **Crowd marks (one third-party request, on by default; turn off with 众包片段库 in the options).** For each video whose
  results are not cached, the background worker asks `bsbsb.top` (BilibiliSponsorBlock, served through Cloudflare):
  - **Sent:** only the first 4 hex digits of `sha256(BV id)`. The server answers with every marked video in that
    bucket, usually several, and the match is made locally, so the server learns only that you watch one of them.
  - **Not sent:** no cookies, no account data, no Referer.
  - **Visible to them anyway:** like any request, it shows your IP address, the browser's User-Agent / Accept-Language,
    and an `x-ext-version: bilibili-ad-skipper/<version>` header, which their API asks clients to send.
  - The answer is cached with the other results for 12 hours.
* The audio/video look-ahead fetches byte ranges of the video's own streams and analyses them in memory. It only runs
  for likely ads the danmaku cannot confirm on their own: most videos need none, about 1 MB per video on average. No
  audio or picture is stored; only the verdict goes into the result cache. Turn it off with **音视频预读核验**. The skip
  button's media check (about 5 MB per press) is a separate setting.
* Settings sync through `chrome.storage.sync`. Per-video ignores and a 12-hour result cache stay in `chrome.storage.local`.
* Host permissions are limited to `www.bilibili.com`, `api.bilibili.com`, `bvc.bilivideo.com` and `bsbsb.top` (the
  crowd lookup), plus, only when you set up the AI transcript check, the one model service you chose (an optional
  permission Chrome asks you about). The video and subtitle CDNs answer the page's own requests, so they need no extra
  permission.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder (`bilibili-ad-skipper`).
3. Open any bilibili video. Detected segments appear as coloured markers on the progress bar
   (orange = chapter, purple = crowd mark, teal = AI subtitles, pink = danmaku, green = your own, striped = low confidence, dashed = offer only).
4. **Set up the AI transcript check** (recommended): open the extension's options, pick a model service, paste your API
   key and press **保存并测试**. Claude Haiku 5.5 is the tested default; Zhipu GLM-4.7-Flash is free; DeepSeek and Qwen
   work from mainland China. The test sends a short made-up transcript and checks the answer.
5. After updating the files (e.g. `git pull`), press the extension's **reload** icon on `chrome://extensions`. Until you do,
   Chrome keeps running the old version; the extension notices the mismatch and says so in a toast on the video page.

## Using it

* **Auto mode** (default): when playback enters an ad, it jumps to the end and shows a toast `已跳过广告 4:12 → 6:00` with **撤销**.
  Undo seeks back and remembers that segment as "not an ad" for this video. Ignored segments stay on the progress bar
  (dimmed) and in the popup with a **恢复** button.
* **Manual mode**: a **跳过广告 ▶** button appears instead; click it to skip.
* **Missed an ad?** Click the **⏭** button in the player's control bar (or 跳过正在播放的广告 in the popup) while the ad
  plays. It jumps at once, using everything known around that moment, even evidence too weak to auto-skip on, in this
  order: a segment shown but not skipped; 空降 coordinates posted near now; landing danmaku (欢迎回来 / 空降成功); the
  sponsor read in the AI subtitles; the heat curve; a single coordinate; a chapter boundary at most 20 s ahead. If
  nothing is found it moves forward 15 s and offers **再前进**. Otherwise the toast offers **撤销** and **记住** (save it
  as an ad for this video, so it is skipped automatically next time). When the results came from the cache it may wait
  up to 2.5 s for the danmaku / subtitles. An optional media check (off by default, a few seconds and about 5 MB per
  press) measures the end from the video's own audio and picture instead.
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
src/content/22-api.js         view / player info / danmaku / subtitle fetch (direct, with background fallback)
src/content/28-detect-subtitles.js  keyword fallback: sponsor reads in the AI subtitles (calls to action + product name)
src/content/29-detect-llm.js  AI transcript check: prompt, answer validation (quotes, line ranges), candidates
src/llm-providers.js          model services: Anthropic Messages / OpenAI-compatible request + reply mapping (background)
src/content/30-detect-chapters.js
src/content/31-detect-danmaku.js
src/content/32-media.js       frame/audio transition analyzer
src/content/34-detect-heat.js 高能进度条 heat curve: ad-shaped runs, confirmation, guard, offers
src/content/35-skip-here.js   "skip the ad playing now": end estimate for ads the detectors missed
src/content/36-media-probe.js look-ahead: DASH byte index (sidx), ranged fetch, fMP4 demux, audio/video decode, features
src/content/37-av-segment.js  look-ahead judgement: is it an ad, where does it end (pure, tested)
src/content/38-pipeline.js    candidates → segments (heat, A/V, end-zone gate, fusion); shared with tools/eval-bsb.js
src/content/39-detect-crowd.js crowd marks (BilibiliSponsorBlock) → candidates
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

Audio/video look-ahead (7 measured ads; 5 700 slices of 15–130 s of ordinary content, a story skip, a benchmark skip
and three opening skips):

| | result |
|---|---|
| Measured ads confirmed, with the boundaries handed to it 2–6 s off | 7 / 7 |
| Ad end found from the media (open-ended danmaku starts, skip button) | −2.1 … +0.2 s from the real end |
| Content slices confirmed as an ad (audio + video / audio only) | 0 / 5 726 and 0 / 5 728; of the 632 ad-length (60–130 s) ones, 585 are refuted |
| Story skip, benchmark skip, opening skips confirmed as an ad | 0 / 5 |
| Skip-button presses at every second inside an ad: landing vs the real end | −2.1 … +0.2 s (687 presses) |
| Live check on bilibili (v0.4.1, 2026-10-17) | measured ads auto-skipped (ends from the danmaku, e.g. 1.2 s late on BV1jCJs6UE9S); the thin-danmaku ad gets its end from the media; an intro the media calls ad-like stays a button |
| Cost per suspected segment | 4–12 MB (audio ≈ 66 kbps + 360p video 125–400 kbps depending on the codec), 4–10 s in the background; at most 60 MB per video |

### AI transcript check (2026-10-26)

Test data: the AI subtitles of 290 BilibiliSponsorBlock videos, read signed in. Set A, 76 videos, is the one the prompt
and the answer checks were written against. Set B is held out: 214 videos, 156 with a crowd-marked sponsor read and 58
controls where people marked only other things. The model got exactly the request the extension sends, and its answers
went through the extension's own checks (`BAS.detectLlm.parseReply`). Every disagreement with the crowd was then judged
by three independent strong-model reviewers reading the transcript.

| Held-out set B | Claude Haiku 5.5 | Claude Opus 5.5 (default) |
|---|---|---|
| Crowd-marked ads auto-skipped (IoU ≥ 0.4), first answer | 159 / 174 (91.4 %) | 164 / 174 (94.3 %) |
| … with the second question for uncertain reads | **163 / 174 (93.7 %)** | **164 / 174 (94.3 %)** |
| Crowd-marked ads auto-skipped or offered | 96.0 % | 96.6 % |
| Auto-skips on content nobody marked | 6 of 180; reviewers judged all 6 to be real ads the crowd had missed | 5 of 180; the 4 reviewed were real ads |
| Auto-skips on the 58 control videos | 3 videos, all real sponsor reads (Snyk, JD esports, a sponsor segue) | 2 videos, real |
| Start / end vs the crowd label, median (p10 … p90) | 0.0 s (−3.5 … +4.3) / −0.1 s (−1.5 … +0.8) | −0.1 s (−6.2 … +0.6) / −0.1 s (−1.2 … +1.0) |
| Invalid replies | 0 of 214 | 0 of 214 |

On set A (development): 95.6 % → 96.7 % with the second question (Haiku), 90.1 % (Opus; several of its labels are
disputed or whole-video sponsorships), no auto-skip on unmarked content. Opus rates its reads more cautiously than
Haiku, so its auto-skip threshold is 0.75 instead of 0.85 (calibrated on these sets: 10 of its 11 reads at 0.75–0.85
were crowd-marked ads). Cost per video at about 10 000 transcript tokens: Opus 5.5 about $0.04, Haiku 5.5 about $0.001;
set `claude-haiku-5-5` as the model in the options to use it.

What the remaining misses are, by the reviewers' reading of the transcript: a game tie-in that is the premise of the
whole video (no separate read), a short sponsor mention in passing (5–11 s), and reads the model found but scored
below the auto-skip threshold; those are offered with the button, and the second question promotes most of them. Of
the confident reads (model confidence ≥ 0.9), 246 of 252 matched a crowd mark and none was judged to be content.

Without AI subtitles there is nothing to read: 41 of the 197 sponsored videos in set B had none listed for a
signed-in viewer. For those the other sources (crowd marks, danmaku, heat) still apply.

### AI subtitles: keyword fallback (2026-10-26)

Transcripts of 100 crowd-labelled videos were read signed in; 76 had a matching AI subtitle file (32 000 lines). These
are the videos the vocabulary and rules were developed on, so the numbers are optimistic; checking them on videos the
rules have not seen is the next step.

| on the 94 of those videos with collected danmaku, crowd marks off | without subtitles | with subtitles |
|---|---|---|
| Labelled ads auto-skipped (IoU ≥ 0.4) | 22 / 101 (22 %) | **43 / 101 (43 %)** |
| Labelled ads at least offered | 38 % | 54 % |
| Auto-skips on content nobody labelled | 0 / 22 | 0 / 50 |
| Auto-skips ending > 3 s past the label | 0 | 3 (3 – 11 s) |

The subtitle detector alone covers 46 % of the labelled ad time and wrongly covers 33 s of content in 76 videos (one
coupon joke, shown as an offer, not skipped). Its starts are a median 2.7 s after the label (the segue line plays), its
ends 2.1 s before it. Skip-button presses at ¼, ½ and ¾ of each labelled ad (252 presses) land within 3 s of the
labelled end 65 % of the time (61 % without subtitles); with a 空降 consensus 92 %, with only a blind step 21 %.

### Crowd marks + detectors on today's popular videos (2026-10-17)

583 videos from bilibili's 热门 and 每周必看 lists (median 1.5 days old; danmaku fetched signed out, median 292 per
video). Crowd marks were taken from that day's BilibiliSponsorBlock dump, as the extension would receive them.

| | detectors (danmaku, heat, chapters) | crowd marks | both (the extension) |
|---|---|---|---|
| Videos with an auto-skip | 14 | 48 | **52** |
| Ad segments auto-skipped | 14 | 57 | **61** |
| Estimated share of all ads in these videos | ~18 % | ~70 % | **~75 %** |

* **Overlap:** both sources found the same ad 10 times. Their starts differ by a median 2.9 s, their ends by 0.4 s.
* **Precision, checked by eye** (a frame from inside each segment): all 4 detector-only skips and all 8 sampled
  crowd-only skips were real ads.
* **How the share was estimated:** capture–recapture over the overlap puts the ads in these videos at about 80. That is
  rough, since the two sources are not independent.
* **Hand-measured set:** crowd marks found 7 / 7 frame-measured ads (start −3.4 … +1.6 s, end −0.6 … +1.8 s) and nothing on
  the 19 verified ad-free videos.

### Crowd-labelled test (BilibiliSponsorBlock, 2026-10-17)

The public dump of [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) (crowd-marked segments of
~300 000 bilibili videos) gives labels at scale. Test set: 290 videos with a sponsor segment other users confirmed
(votes ≥ 2), 305 ads in total, plus 84 control videos where people marked other things (intro, outro …) but never a
sponsor. Inputs were fetched **signed out** (median 492 danmaku per video; a signed-in viewer gets several times more),
so this is the extension's worst case. A hit is an auto-skip overlapping the label with IoU ≥ 0.4.

| | danmaku | + heat | + heat + audio/video |
|---|---|---|---|
| Ads auto-skipped | 69 / 305 (22.6 %) | 74 / 305 (24.3 %) | **87 / 305 (28.5 %)** |
| … with < 300 / 300–1000 / > 1000 danmaku | 14 % / 21 % / 41 % | 13 % / 22 % / 50 % | 17 % / 27 % / 52 % |
| Ads at least offered (skip button) | 37 % | 39 % | 39 % |
| Auto-skips on content nobody labelled | 0 / 69 | 0 / 74 | 0 / 87 |
| Control videos with an auto-skip | 2 / 84 | 3 / 84 | 3 / 84 (all on ranges users marked as intro / outro) |
| Start vs label, median | 3.1 s late | 3.1 s late | 3.0 s late |
| End vs label, median / p90 of the error | 0 / 2.2 s | 0 / 2.8 s | 0 / 4.2 s |

Most misses (176 of 305) have no signal at all in the signed-out danmaku. This test also changed the audio/video
rules. The first look-ahead version (v0.4.0) also vetoed segments that did not look like ads. That veto blocked real ads,
and it made that version worse than no look-ahead: 58 instead of 87 ads. Snapping ends to a transition also made as many
ends worse as better against the crowd. To rerun the test: `tools/bsb-prepare.py`, `tools/bsb-collect.py` and
`tools/eval-bsb.js`. The labels and collected inputs stay local; they are third-party data.

## Limitations

* Danmaku-based detection needs viewers to have reacted; very new or unpopular videos may have no usable danmaku.
  Logged-in users receive far more danmaku than anonymous ones.
* AI subtitles are listed only for signed-in viewers, and only about three in four videos have them. A read without a
  call to action (only the product praised, "感兴趣可以去看看") is not found from the subtitles. A product mentioned in
  the content (a review, a sale guide) can look like a read with one call to action; that is why one is only offered.
* Boundaries come from crowd timing: a skip typically starts ~3 s after the crowd-labelled start (the segue into the
  ad plays) and ends within a couple of seconds of the labelled end.
* The audio/video check only confirms: about a quarter of real ads are clearly louder, steadier and brighter than their
  surroundings; the rest are left to the danmaku. Intros and OP songs look the same to it, so bare 空降 coordinates
  never get its boost.
* Only verified on a handful of channels' audiences (小约翰可汗, 半佛仙人, 极客湾, 影视飓风); other communities' conventions
  are parsed but untested.
* Only `www.bilibili.com/video/*` (plus `/list/*`, `/festival/*`) pages; bangumi/live are out of scope.
* Bilibili's own pre-roll/overlay ads are not touched.
