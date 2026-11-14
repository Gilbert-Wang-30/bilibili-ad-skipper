# Bilibili Ad Skipper（恰饭跳过）

A Chrome (Manifest V3) extension that detects and skips in-video sponsored segments (恰饭 / 植入广告) on
`www.bilibili.com/video/*`. Detection runs locally in your browser. There is no server of its own, no accounts and no
analytics. The one third-party request, the optional crowd-mark lookup, is described under Privacy.

> Unofficial project, not affiliated with bilibili. Released under the MIT license.

## How it detects an ad

Seven independent signals are fused into time segments with a confidence score:

| Signal | What it uses | Confidence |
|---|---|---|
| **Chapters (章节 / 视频看点)** | Uploader chapters from the player API whose title says 广告 / 恰饭 / 赞助 / 推广 / 商单 … | 0.95 |
| **Crowd marks (小电视空降助手)** | Segments that viewers of [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) marked by hand and voted on (downvoted ones are hidden). Where a video has one it is the most precise signal (edges within ~1 s); a disputed mark is only offered, and so is a mark nobody has voted on yet unless one of the detectors below agrees (about one in eight such marks is not an ad). | 0.9 – 0.98 |
| **AI subtitles (AI 字幕)** | What the uploader says, from the video's AI subtitle file. **No AI service, no API key, nothing sent anywhere:** everything runs on numbers that ship with the extension. A small neural network (2.9 million numbers, stored as 8-bit integers; trained offline on 13 192 crowd-labelled videos) reads every line — its characters, its timing, what the danmaku and the heat curve say at that moment and (v4.1.0) what the danmaku network below makes of that moment — in the context of the whole video, and gives it the probability that it belongs to a sponsor read. A read is where that probability rises and stays high; its edges sit on lines the network is sure of. Each stretch is then scored as a whole (a logistic regression over its statistics, the danmaku around it and the older phrase-weight / boosted-tree line scores, which still ship as inputs and as the fallback). p ≥ 0.75 auto-skips when another kind of evidence agrees (a crowd mark, the danmaku, the heat curve), p ≥ 0.9 on its own; below that it is offered as a button (from 0.5). A video that sells from start to end (more than four auto-skipped reads, or reads over 40 % of it) is only offered. | 0.5 – 0.95 |
| **Danmaku (弹幕)** | All danmaku of the video (same protobuf API the player uses). Clusters of *ad announcements* (恰饭了, 广告来了, 零帧起手, 感谢金主…), *jump cues* (空降 6:00, 跳伞04:50, 745工程, 坐标609, 向右20下 …) and *landing thanks* (欢迎回来, 空降成功, 感谢609工程 …). The median of agreeing jump targets gives the end; thanks clusters confirm it. For a video **without subtitles**, a small neural network (v4.1.0; trained on 38 345 labelled videos, shipped as 1.1 MB of weights, runs locally; no AI service) reads the danmaku themselves in 3-second steps — what viewers wrote there, plus the same danmaku classes and the heat curve — and finds ads these hand-written rules miss: it auto-skips at p ≥ 0.9 when another kind of evidence agrees, at p ≥ 0.95 on its own, and offers a button from 0.6. Viewers' own coordinate memes ("745冲", "745是好地方") count once several viewers post the same time and viewers then land there (欢迎回来 …). | 0.2 – 1.0 |
| **Viewer heat (高能进度条)** | The player's own viewer-activity curve (about 100 samples per video, served without login). When many viewers drag past an ad, the curve ramps up across it, peaks at its end and falls off a cliff. A danmaku segment that matches gets +0.2 confidence, which lets thin danmaku (e.g. signed out) still auto-skip. On popular videos it also blocks hand-written danmaku auto-skips that have no 空降 coordinates when the curve shows no skipping (the learned danmaku / heat model's skips are exempt: it already read the curve). Alone, it only offers a manual skip button. | confirmation |
| **Audio / video look-ahead** | For a likely ad the danmaku cannot confirm on their own (they name an ad but are too few), *before you reach it*, the extension downloads just that stretch (plus 45 s around it) of the video's own lowest-bitrate audio track and its 360p picture, using the byte index every bilibili stream carries (about 4–12 MB per segment, at most 60 MB per video), decodes it in the page (`decodeAudioData`, WebCodecs) and compares the inside with the surroundings. Many sponsored reads are **louder**, **steadier** (narration over music, no pauses) and **brighter** than the video around them. When a segment clearly is, and its danmaku name an ad (恰饭 / 广告 … or landing thanks), it gets +0.25 confidence. That lifts thin-danmaku ads to auto-skip. It also finds the end for danmaku that only announce an ad's start. It never blocks a segment: on crowd-labelled ads a third of the real ones looked no different from their surroundings. | confirmation, open-ended ends |
| **Live frame cuts** | While the video plays, low-resolution frame differences (and optionally the audio level/spectrum via `captureStream`, never re-routing playback) record hard cuts. Cuts within a few seconds of a boundary that the look-ahead did not already fix snap it to the exact frame. | refinement only |

Rules that keep false positives down (all learned from 50 real videos, see `test/fixtures/expected.json`):

* A segment is **auto-skipped only when confidence ≥ 0.6** (configurable). For a danmaku segment that requires either ≥ 3 viewers agreeing on a landing time, or explicit ad vocabulary **plus** a strong end marker — and, since v4.2.0, a second kind of evidence unless ≥ 3 coordinates agree. A lone "跳伞23:36" or story words like 躲过一劫 never auto-skip.
* "打钱 / 商单 / 广子" jokes that are spread over a whole sponsored review, "开屏广告" discussions, "怎么还没广告" anticipation and other negations are ignored.
* Opening skips ("跳伞04:50" posted at 0:00, "正片2:00", "省流 跳转4:00") are shown as an **offer** (a skip button and a dashed marker) but never skipped automatically.
* **Two kinds of evidence before an auto-skip (v4.2.0).** A skip happens on its own only when two different kinds of
  evidence agree (crowd mark, AI subtitles, danmaku, heat curve, chapters), or when its one kind is strong: an uploader
  chapter, a crowd mark viewers voted for (or a moderator locked), a subtitle read the model is at least 90 % sure of,
  the danmaku network at least 95 % sure, or three agreeing 空降 coordinates. Anything else is offered as a skip button.
  Viewer comments can be wrong — a team's sponsor discussed in a racing video (reported by a user), a car model like
  "A 110" read as 1:10 — so danmaku alone rarely decide; a number written after a letter, or a bare number that viewers
  keep posting more than a minute after its time, is treated as a name, never as a jump target.
* Jump targets into the very end of a video (the last 1 %, at least 8 s) are ignored: those are "skip to the end"
  jokes. A segment that ends in the last 3 % (at least 20 s) may be an ad before a short outro, or a joke. It is only
  skipped automatically when the audio/video check strongly confirms it and its danmaku name an ad.
* Crowds also post coordinates for things that are not ads: a famous moment (名场面), the good part, an intro or OP song.
  Bare coordinates never get the audio/video boost (intros look and sound like ads to it), so such a cluster needs the
  same agreement as before to auto-skip. On 374 crowd-labelled videos no auto-skip landed on content nobody had marked.

## Privacy

* Detection talks to bilibili's own servers (`api.bilibili.com`, `bvc.bilivideo.com` and the video CDN the player itself
  streams from), making the same kind of requests the bilibili player makes. There is no analytics.
* **AI subtitles (on by default; turn off with 字幕口播识别).** The list of subtitle files is read from the player's own
  `x/player/wbi/v2` response. When that lists none (bilibili lists AI subtitles there only to signed-in viewers), the
  list comes from one request to `api.bilibili.com/x/v2/dm/view`, the same kind of bilibili API call as the danmaku
  ones. The chosen file (the AI Chinese track, else the uploader's Chinese one) is downloaded when the video is analysed
  (a visit with no results from the last hour) from bilibili's subtitle CDN (`aisubtitle.hdslb.com`, or `i0.hdslb.com`
  for an uploader's file), without cookies, exactly as the player does when subtitles are turned on. The text is scored
  in memory with the small neural network, weight tables and decision trees that ship with the extension (together with
  the danmaku and heat curve the extension already loads); no AI service or model download is involved, and only the
  resulting segments go into the result cache.
* **Crowd marks (one third-party request, on by default; turn off with 众包片段库 in the options).** For each video without
  results from the last hour (results are kept 12 hours but refreshed in the background after one), the background
  worker asks `bsbsb.top` (BilibiliSponsorBlock, served through Cloudflare):
  - **Sent:** only the first 4 hex digits of `sha256(BV id)`. The server answers with every marked video in that
    bucket, usually several, and the match is made locally, so the server learns only that you watch one of them.
  - **Not sent:** no cookies, no account data, no Referer.
  - **Visible to them anyway:** like any request, it shows your IP address, the browser's User-Agent / Accept-Language,
    and an `x-ext-version: bilibili-ad-skipper/<version>` header, which their API asks clients to send.
  - The answer is cached with the other results.
* The audio/video look-ahead fetches byte ranges of the video's own streams and analyses them in memory. It only runs
  for likely ads the danmaku cannot confirm on their own: most videos need none, about 1 MB per video on average. No
  audio or picture is stored; only the verdict goes into the result cache. Turn it off with **音视频预读核验**. The skip
  button's media check (about 5 MB per press) is a separate setting.
* Settings sync through `chrome.storage.sync`. Per-video ignores and a 12-hour result cache stay in `chrome.storage.local`.
* **Volume curve (on by default; 音量曲线 in the options).** On `www.bilibili.com` and `live.bilibili.com` pages a small
  page script remaps the players' volume slider through a perceptual curve. It reads nothing and sends nothing; the
  extension's own script on the page hands it the setting. Like any page script, it lets bilibili's pages (and scripts
  they load) tell that the extension is installed and which curve is set; nothing else is exposed.
* Host permissions are limited to `www.bilibili.com`, `api.bilibili.com`, `bvc.bilivideo.com` and `bsbsb.top` (the
  crowd lookup); the extension's scripts also run on `live.bilibili.com`, for the volume curve only. The video and
  subtitle CDNs answer the page's own requests, so they need no extra permission.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder (`bilibili-ad-skipper`).
3. Open any bilibili video. Detected segments appear as coloured markers on the progress bar
   (orange = chapter, purple = crowd mark, teal = AI subtitles, pink = danmaku, green = your own, striped = low confidence, dashed = offer only).
4. After updating the files (e.g. `git pull`), press the extension's **reload** icon on `chrome://extensions`. Until you do,
   Chrome keeps running the old version; the extension notices the mismatch and says so in a toast on the video page.
   Updating from v1.0.0 (which sent the subtitles to an AI model) deletes the API key, AI settings and AI answers it
   stored; nothing from that version is used any more.

## Using it

* **Auto mode** (default): when playback enters an ad, it jumps to the end and shows a toast `已跳过广告 4:12 → 6:00` with **撤销**.
  Undo seeks back and remembers that segment as "not an ad" for this video. Ignored segments stay on the progress bar
  (dimmed) and in the popup with a **恢复** button.
* **Manual mode**: a **跳过广告 ▶** button appears instead; click it to skip.
* **Missed an ad?** Click the **⏭** button in the player's control bar (or 跳过正在播放的广告 in the popup) while the ad
  plays. It jumps at once and is built never to jump past the ad into the video: it lands a second before the earliest
  end it can trust — a segment it was sure of, two or more agreeing 空降 coordinates posted near now, or the sponsor read
  in the AI subtitles (also a weaker one the detector did not skip). Weaker hints (landing danmaku 欢迎回来 / 空降成功,
  the heat curve, a single coordinate, a segment it was not sure of, a chapter boundary) are only used when they lie
  within 5 s; otherwise it moves forward 5 s and offers **再前进** — press again while the ad still plays. Otherwise
  the toast offers **撤销** and **记住** (save it
  as an ad for this video, so it is skipped automatically next time). When the results came from the cache it may wait
  up to 2.5 s for the danmaku / subtitles. An optional media check (off by default, a few seconds and about 5 MB per
  press) measures the end from the video's own audio and picture instead.
* If you seek into a skipped segment yourself, it is not skipped again until you leave it.
* **Popup** (toolbar icon): on/off, mode, the list of segments (跳到此处 / 忽略), low-confidence candidates, manual marking
  (标记广告开始 / 结束), 重新检测, 清除本视频覆盖.
* **Options**: confidence threshold, which signals to use (incl. the audio/video look-ahead), live audio analysis (off by default), markers/toast, landing offset,
  extra keywords, ignored UP主 (mid or space link), debug logging, export/import, the volume curve.
* **Volume that sounds even** (videos and live rooms): bilibili's players set the media element's volume straight from
  their slider, and that is an amplitude, so most of the slider sounds loud (50 % is only 6 dB below full) and the quiet
  end barely exists. The extension plays slider value ^ 2.5 instead (50 % ≈ −15 dB, 20 % ≈ −35 dB, 10 % ≈ −50 dB), while
  the player still shows and remembers the slider value. 音量曲线 in the options: 关闭 / 柔和 (^1.8) / 标准 (^2.5) / 强 (^3.5).

Per-video overrides and a 12-hour result cache live in `chrome.storage.local`; settings sync via `chrome.storage.sync`.

## Project layout

```
manifest.json                 MV3 manifest (content scripts in load order, MAIN-world bridge)
src/page-bridge.js            MAIN world: page state (aid/bvid/cid/p) + observed player API responses → postMessage
src/volume-curve.js           MAIN world (www + live): the media elements' volume through a perceptual curve
src/volume-settings.js        isolated world (www + live): hands the volume-curve setting to the page script
src/content/00-ns.js          BAS namespace, utils (time parsing incl. 空降 formats), defaults
src/content/10-storage.js     settings / overrides / cache
src/content/20-protobuf.js    danmaku protobuf decoder
src/content/21-wbi.js         WBI signing (md5) for the signed API variants
src/content/22-api.js         view / player info / danmaku / heat / subtitle list + file / crowd lookup (api.bilibili.com
                              direct with background fallback; crowd lookup via the background; subtitle files direct)
src/content/26-nn-line.js          the neural line model's forward pass (plain JS) and its stretch decoder / scorer
src/content/26-nn-model.js         its weights (int8, generated), character list, decoder and scorer settings
src/content/27-subtitle-model.js    the learned models (generated from crowd-labelled videos): phrase-weight and edge tables, the line trees, the danmaku / heat bin model
src/content/28-detect-subtitles.js  sponsor reads in the AI subtitles (neural path; phrase weights, boosted trees, segmenter, edges as inputs and fallback), skip-button reads
src/content/29-media-features.js    danmaku / heat features for the learned models; the danmaku / heat model for videos without subtitles
src/content/29-nn-bins-model.js     weights of the danmaku / heat network (int8, generated) that model uses, its decoder and scorer settings
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

The subtitle weights (`src/content/27-subtitle-model.js`) are generated by a training script that is not part of this
repository: it fits logistic regressions (FTRL for the phrase tables, Newton for the stretch score) and
gradient-boosted decision trees (over each line's context, the danmaku and the heat curve; and over 2-second bins for
videos without subtitles) to the BilibiliSponsorBlock marks and the AI subtitles, danmaku and heat curves of the
labelled videos, cross-validated by uploader. All of that is third-party data and stays local. The file holds only the
resulting numbers: n-grams of 1–3 characters with a weight each, the trees (feature index, threshold, leaf value) and
the detector settings.

The neural line model (`src/content/26-nn-model.js`) is trained with PyTorch by scripts that are not part of this
repository either, cross-validated by uploader the same way. Its training targets are the crowd marks and, as a second
target, the line scores of a much larger model used **only during training**: a pretrained Chinese BERT
([hfl/chinese-roberta-wwm-ext](https://huggingface.co/hfl/chinese-roberta-wwm-ext), Apache-2.0) fine-tuned offline on the
same marks. For the 8 112 main videos its line scores come from the copy fine-tuned without that video's fold (folds by
uploader); the newly collected videos are scored by copies fine-tuned on four of the five folds, so some of them by a
copy that saw other videos of the same uploader. That teacher does not ship and is never run by the extension. The shipped file holds the small network's weights as 8-bit integers with one scale per row, its list of
characters, and the decoder / stretch-scorer settings.

The danmaku / heat network (`src/content/29-nn-bins-model.js`) is the same kind of small network, trained the same way
(PyTorch, scripts not in this repository, 5-fold cross-validated by uploader) on the crowd marks alone — no teacher —
of 38 345 videos (the danmaku XML pool and heat curve of each, fetched signed out; 8 163 of them without subtitles).

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

### False skips on what people watch (v4.2.0, 2026-11-13)

Every auto-skip was read by two independent reviewers (a third on disagreement), blind to which detector fired: the
transcript around it, or the danmaku in it when the video has none. (The reviewers were Claude models, only for this
evaluation; the extension itself calls no AI service.) The extension's detectors and fusion ran as in the browser, crowd
marks on (the live BilibiliSponsorBlock marks, or that day's dump for the October videos), with the danmaku XML pool
instead of the player's own list and without the audio/video check. None of the videos was used for training.

**Independent test** — 325 videos sampled from twelve of that day's category rankings (game, knowledge, tech, cars,
life, food, sports, film, entertainment, animals, animation, music), collected and judged after the v4.2.0 rules were
fixed:

| | v4.1.0 | **v4.2.0** |
|---|---|---|
| Auto-skips | 48 | 27 |
| … judged a real ad (paid, or the uploader's own promotion) | 34 | 26 |
| … judged not an ad | 14 (29 %) | **1 (3.7 %)** |
| Videos with a false skip | 9 of 325 (2.8 %) | **1 of 325 (0.3 %)** |

Of v4.1.0's 14 false skips, 10 were crowd marks nobody had voted on, laid over vlogs, a car-show walk-through or an
appliance review. v4.2.0 turned 13 of the 14 into skip buttons, along with 8 real ads. The false skip left is a subtitle
read (p ≥ 0.9) of a car review's closing remarks about that car.

**Development set** — the 876 popular videos (293 from that day's 热门 / 排行榜, 583 of October) whose judged auto-skips
the rules were chosen on, so these figures are in-sample:

| | v4.1.0 | **v4.2.0** |
|---|---|---|
| Auto-skips / judged a real ad | 114 / 105 | 85 / 84 |
| … judged content, an intro or an outro / unclear | 7 / 2 | 1 / 0 |
| … videos with a false or unclear skip | 8 of 876 (0.9 %) | 1 (0.1 %) |
| Held-out test (375 videos, crowd marks off): ads auto-skipped, XML pool / signed-out danmaku | 81.1 % / 77.8 % | 79.3 % / 75.1 % |
| … skips outside every crowd mark / content cut | 1 / 110 s | **0 / 81 s** |
| ⏭ pressed at ¼ / ½ / ¾ of 312 held-out ads (936 presses): first press lands past the end (content skipped) | 8.8 % | **1.3 %** |
| … pressing until the ad is over: ends within 3 s of it / ever past it | 83.1 % / 14.5 % | **84.3 % / 1.4 %** |
| … presses per ad | 1.3 | 1.7 |

Where the development set's false skips came from: a crowd mark nobody had voted on, alone (6 of 21 judged not an ad
or unclear; 5 of those 6 had no transcript and were judged from the danmaku; with a transcript 11 of 12 were ads), and a
subtitle read alone (3 of 18: a game's intro in a video about that game, an expo walk-through before its sponsored
part, a game guide). All 71 auto-skips where two kinds of evidence agreed were real ads. Of 160 unvoted crowd marks
sampled from the labelled corpus and judged the same way, 137 were ads (86 %) — about one in seven is not — and
checking our own models' weak agreement inside them only raised that to 92 %, so an unvoted mark now needs a detector
to agree. The cost, with crowd marks on: on the 876, judged ads auto-skipped 105 → 84 (most of the rest are now
buttons). The ⏭ policy was chosen on the same 936 presses it is measured on; it no longer trusts landing danmaku, the
heat peak or a blind 15 s step past 5 s (they had landed past the end 28 %, 5 % and 24 % of the time). Not in either
measurement: the user-reported F1 video where viewers discussing a racing team's sponsor made the danmaku network skip
(now a button), and memes like "745是好地方" (the rules now learn a video's own coordinate meme when viewers also land
there).

### Danmaku / heat network (v4.1.0, 2026-11-12)

About one crowd-marked video in four (85 of the 375 held-out ones) has no AI subtitle file; checked again in 2026-11,
only 4 of those 85 had gained one. For them the danmaku and the heat curve are all there is. v4.1.0 replaces the boosted
trees that read them with a small network that also reads **what the viewers wrote** in each 3-second step (the trees
only saw counts of hand-picked danmaku classes). Without that text a network of the default configuration scores 0.864 bin AP on fold 0
instead of 0.894 with it (0.899–0.904 for the tuned variants). Training data: 38 345 crowd-labelled videos (36 132 sponsor marks); none of the held-out videos.

The held-out rows of this table keep the v4.0.2 subtitle model, to show the danmaku network alone; both v4.1.0 changes
together are in the next table.

| | trees (v4.0.2) | **network (v4.1.0)** |
|---|---|---|
| Cross-validation, the 5 747 newer videos without subtitles (never seen by the trees either), ads auto-skipped | 29.0 % at the shipped p ≥ 0.98 (40.4 % at 0.9) | **57.6 %** at the shipped p ≥ 0.9 (51.5 % at 0.95) |
| … skips outside every mark / content cut per video / ad-free control videos cut | 12 / 2.0 s / 1 (at 0.98) | **3 / 0.5 s / 2** |
| **Held-out test**, whole extension, all 375 videos (danmaku XML pool, the kind trained on) | 75.1 % | **79.9 %** |
| … the 85 without subtitles | 59 % (40 of 68) | **82 %** (56 of 68) |
| … with the signed-out danmaku the extension itself fetched (a signed-in viewer gets more), all / without subtitles | 71.2 % / 47 % | **76.3 % / 72 %** |
| … skips outside every crowd mark / content cut | 0 / 228 s | **0 / 81 s** |
| Popular videos without subtitles (158): auto-skips / inside a crowd sponsor mark | 4 / 3 | **8 / 5** |

Of the three popular-video skips no crowd mark covers, the danmaku inside two say plainly that an ad is playing
("两个广子", sponsor jokes, landing codes); the third is an anime's opening song that viewers 跳伞 past — the kind of
thing the network can mistake for an ad. (Read by a Claude model during the evaluation; the extension calls no AI
service.) A signed-in viewer's player loads more danmaku than the XML pool (about 1.9× on the public example video), so
for a busy video the network reads the newest ones up to the pool's size (videos longer than an hour were not in its
training data). Cost: 1.1 MB of weights; about 0.25 s of arithmetic for an hour-long video, in slices of at most ~30 ms.

The same release changes how overlapping estimates merge: a skip that would auto-skip on its own no longer grows by a
weak, longer estimate that overlaps it — the weak estimate's own parts outside the skip stay offered as a button (on
held-out: same recall, content cut 86 → 81 s; on one popular video it turned a 212-second skip into the 18-second ad
the crowd marked). An ignored or undone range is also cut out of what it only partly covers.

**The subtitle model reads the network too.** For videos with subtitles, the line network now also gets the danmaku
network's probability for each line's moment as one more input (retrained on the same 13 192 videos with that input
taken out of fold; the decoder and stretch scorer refitted the same way). Skips outside every mark were judged blind by
two Claude models, as for v4.0.

| | v4.0.2 | **v4.1.0** |
|---|---|---|
| Cross-validation, 8 112 videos: crowd ads auto-skipped at p ≥ 0.75 | 84.3 % | **84.8 %** |
| … skips judged content / content cut | 0 / 1 009 s | 1 (an 18-second overrun right after a real plug) / **818 s** |
| … at p ≥ 0.8 | 83.7 % / 982 s | **84.3 % / 662 s** |
| **Held-out**, the 290 videos with a transcript, whole extension (XML pool / signed-out danmaku) | 79.2 % / 77.4 % | **80.8 % / 79.2 %** |
| … content cut / skips outside every crowd mark | 68 s, 69 s / 0 | 97 s, 125 s / 1 (a car plug that runs on into thanks for free footage) |
| **Held-out, all 375 videos, both changes** (XML pool / signed-out danmaku) | 75.1 % / 71.2 % | **81.1 % / 77.8 %** |
| Popular videos with a transcript (419): auto-skips | 52 | 55: 5 new (2 inside crowd sponsor marks, 2 unmarked paid reads, 1 the uploader's own shop sale), 2 no longer (1 inside a mark) |
| Skip button, 936 held-out presses, with the danmaku: within 3 s of the labelled end | 76 % (81 % with a transcript) | 75 % (80 %) |
| Scoring time, a 100-minute transcript with 20 000 danmaku | ~1.0 s, longest task ~56 ms | ~1.3 s, longest task ~39 ms |

### Neural line model (v4.0.0, 2026-11-10)

Training data: the 8 112 videos below plus 5 080 newly collected ones whose BilibiliSponsorBlock sponsor marks nobody
has voted on yet (13 192 videos with AI subtitles, danmaku and heat curves, fetched signed out). Out-of-fold results
are by uploader; skips outside every crowd mark were read by two independent reviewers blind to the model's score (a
third on disagreement; the reviewers were Claude models given the transcript — only for the evaluation, the extension
itself calls no AI service), and those judged a real paid read the crowd never marked are not counted as false skips.
Caveat: in this cross-validation a training video's soft targets come from teacher copies fine-tuned on folds that
include the fold being tested. Re-run with every target from a teacher copy that never saw the tested fold, the same
recipe auto-skips 84.2 % at p ≥ 0.75 with 3 skips judged content and 1 122 content seconds (line AP 0.980 vs 0.982),
so the leak is small. The held-out test is clean (its videos were never used for fitting, tuning or the teacher).

| | v3 (phrase weights + trees) | **v4 (neural line model)** |
|---|---|---|
| Cross-validation, 8 112 videos: crowd ads auto-skipped (IoU ≥ 0.4) | 81.4 % at p ≥ 0.8 | **84.3 %** at p ≥ 0.75 |
| … skips judged content (outside every mark) / content cut | 0 / 1 005 s | 0 / 1 009 s |
| … at every threshold from 0.5 to 0.9 | | 2.2 – 2.4 points higher at the same or less content cut |
| **Held-out test** (never used for fitting or tuning), the 290 videos with a transcript, whole extension | 75.1 % | **77.4 %** |
| … the transcript model alone (content cut) | 74.7 % (8 s) | **77.0 %** (4 s) |
| … all 375 held-out videos | 69.4 % | **71.2 %** |
| … skips outside every crowd mark | 0 | 0 |
| … with the danmaku XML pool the models were trained on (290 videos) | 76.6 % | **79.2 %** |
| Popular videos: auto-skips from the subtitles (+ 4 from the unchanged danmaku / heat model in both) | 49 (51 of all 53 real) | **52, 50 a real paid read** (1 the creator's own books, 1 a video about becoming a brand ambassador) |
| … blind sample (160 videos read in full): sponsor reads auto-skipped | 19 / 35 | 19 / 35 |
| Skip button (936 held-out presses): lands within 3 s of the labelled end | 75 % (81 % with a transcript) | **76 %** (82 %; where its end comes from was chosen on these same presses) |
| Scoring time, longest transcripts (in short tasks) | ~0.06 s per 1 000 lines | ~0.4 s per 1 000 lines; no task over ~40 ms at 3 000 lines (v4.0.2; v4.1.0: see above) |

For scale: on held-out set B (214 of those videos, 174 crowd ads), v4 auto-skips 135 (77.6 %; 139 with the XML danmaku);
the language-model design of v1.0.0 (an LLM reading the transcript through an API, since removed) skipped 164 (94.3 %).
Most of that gap is products woven into the content — a sponsor's hardware in a PC build, a car brand in a travel vlog
— which a small network trained on crowd marks rarely recognises, plus English transcripts.

### Learned models: subtitles, danmaku, heat (v3.0.0, 2026-10-27)

Training data: **8 112 crowd-labelled videos with AI subtitles** (7 691 with 8 337 BilibiliSponsorBlock sponsor marks,
and 421 control videos where people marked other things but never a sponsor). The danmaku / heat model was fitted on
10 529 videos (8 167 with a transcript, 2 362 without; 10 789 sponsor marks, 607 control videos). Transcripts, danmaku (the video's danmaku XML pool) and heat curves were fetched signed out. Shipped
settings: subtitle reads auto-skip at p ≥ 0.8, the danmaku / heat model at p ≥ 0.98. "Outside every mark" = a skip
with < 30 % of it inside any crowd mark; "content cut" = skipped seconds outside every mark ± 3 s.

| | ads auto-skipped (IoU ≥ 0.4) | skips outside every mark | ad-free control videos with content cut | content cut |
|---|---|---|---|---|
| Cross-validation by uploader (no uploader in both training and test), subtitle model | **81.4 %** of 8 337 | 1 | 0 of 421 | 1 030 s in 8 112 videos |
| … by ad length: 40–90 s / 90–180 s / 20–40 s / under 20 s | 91 % / 89 % / 78 % / 40 % | | | |
| Cross-validation, danmaku / heat model, videos without subtitles | 53 % of 2 406 (60 % at p ≥ 0.95) | 1 | 1 of 177 | 5 870 s in 2 362 videos |
| **Held-out test** (375 videos never used for fitting or tuning, crowd marks off), whole extension | **69.4 %** of 333 (v2.0: 60.4 %) | 0 | 0 of 84 | 166 s |
| … the 290 with subtitles | **75.1 %** of 265 (v2.0: 70.2 %) | 0 | 0 of 58 | 73 s |
| … the 85 without subtitles | **47 %** of 68 (v2.0: 22 %) | 0 | 0 of 26 | |
| … the subtitle model alone (with the danmaku / heat it reads) | 74.7 % of 265 (78.1 % at least offered) | 0 | 0 of 58 | 8 s |

The held-out danmaku are the signed-out ones the extension itself fetched (a signed-in viewer gets several times more).
With the larger XML pool the models were trained on, the same rows read 73.0 %, 76.6 % and 59 %.

**What the misses are.** Two reviewers independently read 120 randomly drawn crowd marks that an earlier v3 training
run (on 5 821 of the videos) missed in cross-validation; the shipped model skips 10 of them. The reviewers agreed on 108: 46 % clear sponsor reads, 25 % short mentions under 20 s (a one-line plug), 11 %
products woven into the content (no separate read to cut), 9 % stretches without usable speech in the subtitles, 6 %
not paid ads (mostly the uploader's own shop), 2.5 % misplaced marks. So about **9 in 10 clear sponsor reads** are
auto-skipped; short plugs and woven placements are what is left. Of the "skips outside every mark", the reviewers found
the high-scoring ones to be real sponsor reads the crowd never marked.

**Popular videos** (584 from bilibili's 热门 / 每周必看 lists, 425 with a Chinese subtitle file; most carry no ad). Every
auto-skip was judged against the transcript (or, without one, the danmaku), and a random 160 of the videos were read in
full, blind to the detector, to list every sponsor read. The reviewers were language models given the transcripts
(this is only how the evaluation was done; the extension itself calls no AI service):

| | result |
|---|---|
| Auto-skips that are a real sponsor read | **51 / 53**; 1 the uploader's own merch, 1 content (20 s of a film recap) |
| Content inside the auto-skips | about 72 s of 2 975 s |
| Explicit sponsor reads auto-skipped (blind sample: 27 reads in 24 of 160 videos) | **19 / 27 (70 %)**; crowd marks alone 14 |

**Skip button (⏭)** pressed at ¼, ½ and ¾ of each held-out ad (936 presses, with no known segment passed in: neither
crowd marks nor the detectors' own segments): lands within 3 s of the labelled end **75 %** of the time (81 % on videos
with a transcript), against 60 % without the subtitles. Where both answer (181 presses), the subtitle read (92 %) beats
the landing danmaku (78 %), so it comes first; that order was chosen on these same presses, the only ones with danmaku
collected.

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
* About three in four videos have an AI subtitle file. For the rest only the danmaku and the heat curve speak: the
  danmaku network skips about seven in ten of their ads on held-out videos, and fewer where few viewers commented. An
  opening song or a long intro that viewers tell each other to jump past (跳伞 / 空降 to its end) can look like an ad
  to it. A product woven into the content (a whole
  sponsored review, a skit, a game played in a vlog, a sponsor's hardware in a build) has no separate read to find and
  is rarely skipped, and short mentions (10–20 s, an app named in passing) mostly score too low to skip. Spec-and-price
  talk (a phone-launch roundup, a sale list) can score like a read; it mostly stays below the auto-skip threshold.
* The subtitle weights were counted from Chinese transcripts: English and other tracks are not downloaded or scored.
* Boundaries: a subtitle skip starts a median 2.2 s after the crowd-labelled start (the segue line may play) and ends
  within 3 s of the labelled end 89 % of the time (the skip button takes the end from the phrase-weight tables when they
  see the read: 82 % of presses land within 3 s on videos with a transcript). Skips from the hand-written danmaku rules start a median 3 s late;
  those of the danmaku / heat model (videos without subtitles) start a median 2–3 s early, one in ten by 12 s or more.
* The audio/video check only confirms: about a quarter of real ads are clearly louder, steadier and brighter than their
  surroundings; the rest are left to the danmaku. Intros and OP songs look the same to it, so bare 空降 coordinates
  never get its boost.
* Only verified on a handful of channels' audiences (小约翰可汗, 半佛仙人, 极客湾, 影视飓风); other communities' conventions
  are parsed but untested.
* Only `www.bilibili.com/video/*` pages (plus `/list/*`, `/festival/*` and the localized `/en/`, `/zh-Hans/`, `/ja/` …
  versions of them); bangumi is out of scope, and in live rooms only the volume curve runs.
* Bilibili's own pre-roll/overlay ads are not touched.
* The neural models add about 5 MB to the extension and about 0.4 s of arithmetic per 1 000 subtitle lines (a long
  transcript has ~1 500) plus about 0.25 s per hour of video for the danmaku network, done in short steps when a video
  is first analysed.
