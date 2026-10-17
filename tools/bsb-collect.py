# Collects what the extension would see for the BilibiliSponsorBlock test videos, through the extension's own API
# layer in the scratch browser (tools/launch-test-browser.sh; one bilibili tab, nothing is played). Resumable.
#   python -I tools/bsb-collect.py inputs   → test/fixtures-full/bsb/videos/BV….json (danmaku, heat curve, chapters)
#   python -I tools/bsb-collect.py av       → test/fixtures-full/bsb/av/BV….json (numbers only, never audio/pictures)
# The A/V step reads test/fixtures-full/bsb/wanted.json (written by `tools/eval-bsb.js --wanted=…`): exactly the windows
# the extension would probe. It downloads about 3–7 MB per window from bilibili's CDN.
# Env: DENO (deno executable, default 'deno'), CDP_PORT (default 9333), BAS_EXT_ID (extension id, see the launch script).
import json, os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
ROOT = os.path.join(REPO, 'test', 'fixtures-full', 'bsb')
DENO = os.environ.get('DENO', 'deno')

INPUTS_JS = r'''
const raw = await BAS.api.getView({ bvid: JOB.bvid });
const v = raw.data || raw;
const pages = v.pages || [];
const page = pages.find((p) => String(p.cid) === String(JOB.cid)) || pages[0] || { cid: v.cid, duration: v.duration };
const cid = page.cid, duration = page.duration || v.duration;
let vps = [];
try { const pi = await BAS.api.getPlayerInfo(v.aid, cid); vps = (pi && (pi.view_points || (pi.data && pi.data.view_points))) || []; } catch (e) { /* none */ }
const dm = await BAS.api.getDanmaku(v.aid, cid, duration, {});
let heat = null;
try { heat = BAS.detectHeat.parse(await BAS.api.getHeat(v.aid, cid, v.bvid)); } catch (e) { heat = null; }
return {
  bvid: v.bvid, aid: v.aid, cid, duration, labelCid: JOB.cid || null, cidMatched: !JOB.cid || String(JOB.cid) === String(cid),
  title: v.title, owner: v.owner ? { mid: v.owner.mid } : null, view_points: vps,
  dm: dm.map((d) => (d.action ? [d.t, d.text, d.action] : [d.t, d.text])), missing: dm.missingSegments || [], heat,
};
'''
AV_JS = r'''
const r3 = (x) => Math.round(x * 1000) / 1000;
const T = performance.now();
const p = await BAS.mediaProbe.probe({ bvid: JOB.bvid, cid: JOB.cid }, JOB.t0, JOB.t1, { video: JOB.t1 - JOB.t0 <= 330 });
return {
  key: JOB.key, t0: JOB.t0, t1: JOB.t1, ms: Math.round(performance.now() - T), bytes: p.bytes, errors: p.errors, full: true,
  audio: p.audio.map((f) => [r3(f.t), r3(f.db), r3(f.flux * 1000), Math.round(f.centroid), r3(f.flatness), r3(f.zcr)].concat(Array.from(f.mel, r3))),
  video: p.video.map((f) => [r3(f.t), r3(f.mean), r3(f.cut), r3(f.drift), r3(f.std), r3(f.sat), r3(f.colorful), r3(f.edge)].concat(Array.from(f.hue, r3))),
};
'''


def evalcs(job, body, timeout):
    fd, path = tempfile.mkstemp(suffix='.js')
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
        f.write('const JOB = ' + json.dumps(job) + ';\n' + body)
    try:
        res = subprocess.run([DENO, 'run', '--allow-net', '--allow-read', '--allow-env', os.path.join(HERE, 'cdp.js'), 'evalcs', 'bilibili.com', path],
                             cwd=REPO, capture_output=True, text=True, encoding='utf-8', timeout=timeout)
        out = json.loads(res.stdout)
        return None if ('error' in out and 'detail' in out) else out
    except (subprocess.TimeoutExpired, ValueError):
        return None
    finally:
        os.unlink(path)


def inputs():
    labels = json.load(open(os.path.join(ROOT, 'labels.json'), encoding='utf-8'))
    sel = json.load(open(os.path.join(ROOT, 'selection.json'), encoding='utf-8'))
    out = os.path.join(ROOT, 'videos'); os.makedirs(out, exist_ok=True)
    for bv in sel['positives'] + sel['controls']:
        path = os.path.join(out, bv + '.json')
        if os.path.exists(path): continue
        cids = [s['cid'] for s in labels.get(bv, []) if s['cid']]
        res = evalcs({'bvid': bv, 'cid': max(set(cids), key=cids.count) if cids else ''}, INPUTS_JS, 120)
        if res is None or 'dm' not in res:
            print('FAIL', bv, flush=True); continue
        json.dump(res, open(path, 'w', encoding='utf-8'))
        print('ok', bv, len(res['dm']), 'danmaku', flush=True)
        time.sleep(1)


def av():
    wanted = json.load(open(os.path.join(ROOT, 'wanted.json'), encoding='utf-8'))
    out = os.path.join(ROOT, 'av'); os.makedirs(out, exist_ok=True)
    total = 0
    for bv, job in wanted.items():
        path = os.path.join(out, bv + '.json')
        store = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
        for w in job['windows']:
            if w['key'] in store: continue
            t0 = max(0, w['start'] - 45)
            t1 = min(job['duration'] - 0.5, (w['start'] + 260) if w['open'] else (w['end'] + 45))
            res = evalcs({'bvid': bv, 'cid': job['cid'], 'key': w['key'], 't0': t0, 't1': t1}, AV_JS, 150)
            if res is None or 'audio' not in res:
                print('FAIL', bv, w['key'], flush=True); continue
            store[w['key']] = res
            total += res.get('bytes') or 0
            json.dump(store, open(path, 'w', encoding='utf-8'))
            print('ok', bv, w['key'], round((res.get('bytes') or 0) / 1e6, 1), 'MB, total', round(total / 1e6), 'MB', res.get('errors') or '', flush=True)
            time.sleep(0.5)


if __name__ == '__main__':
    {'inputs': inputs, 'av': av}[sys.argv[1] if len(sys.argv) > 1 else 'inputs']()
