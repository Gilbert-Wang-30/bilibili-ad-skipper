# Prepares the BilibiliSponsorBlock accuracy test (see tools/eval-bsb.js). Data stays in test/fixtures-full/bsb/
# (gitignored): the crowd labels are third-party data (BilibiliSponsorBlock, https://github.com/hanydd/BilibiliSponsorBlock;
# upstream SponsorBlock data is CC BY-NC-SA 4.0) and are never committed.
#   1. download the public dump:  curl -o test/fixtures-full/bsb/raw/database.zip https://download.bsbsb.top/database.zip
#   2. python -I tools/bsb-prepare.py            → labels.json (no user ids) + selection.json
#   3. python -I tools/bsb-collect.py inputs     → videos/BV….json (needs the scratch browser, tools/launch-test-browser.sh)
#   4. deno run --allow-read --allow-write tools/eval-bsb.js --wanted=test/fixtures-full/bsb/wanted.json
#   5. python -I tools/bsb-collect.py av         → av/BV….json (A/V features of the windows the extension would probe)
#   6. deno run --allow-read tools/eval-bsb.js
import collections, csv, io, json, os, random, sys, zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'fixtures-full', 'bsb')
N_POS, N_CTL, SEED = 300, 100, 20261017


def main():
    z = zipfile.ZipFile(os.path.join(ROOT, 'raw', 'database.zip'))
    csv.field_size_limit(10 ** 8)
    rows = csv.DictReader(io.TextIOWrapper(z.open('sponsorTimes.csv'), encoding='utf-8', newline=''))
    vids = collections.defaultdict(list)
    for row in rows:
        try:
            vids[row['videoID']].append({
                's': float(row['startTime']), 'e': float(row['endTime']), 'cat': row['category'], 'act': row['actionType'],
                'votes': int(row['votes']), 'locked': row['locked'] == '1', 'views': int(row['views'] or 0),
                'hidden': row['hidden'] == '1' or row['shadowHidden'] == '1', 'dur': float(row['videoDuration'] or 0),
                'cid': row['cid'], 'ts': int(row['timeSubmitted'] or 0), 'port': bool(row['ytbID'] or row['portUUID']),
            })
        except (ValueError, KeyError):
            continue
    json.dump(vids, open(os.path.join(ROOT, 'labels.json'), 'w', encoding='utf-8'))

    def good(s, thr):
        return s['cat'] == 'sponsor' and s['act'] == 'skip' and not s['hidden'] and (s['votes'] >= thr or s['locked']) and 15 <= s['e'] - s['s'] <= 400

    rnd = random.Random(SEED)
    # positives: a sponsor segment confirmed by other users (votes >= 2 or locked), one part only
    pos = sorted(k for k, v in vids.items() if any(good(s, 2) for s in v) and len({s['cid'] for s in v if good(s, 2)}) == 1)
    # controls: people labelled other things (voted) but never submitted a sponsor segment
    strict = sorted(k for k, v in vids.items() if not any(s['cat'] == 'sponsor' for s in v)
                    and sum(1 for s in v if not s['hidden'] and s['votes'] >= 1 and s['act'] == 'skip') >= 2)
    loose = sorted(k for k, v in vids.items() if not any(s['cat'] == 'sponsor' for s in v)
                   and any(not s['hidden'] and s['votes'] >= 1 and s['act'] == 'skip' for s in v) and k not in set(strict))
    controls = rnd.sample(strict, min(N_CTL, len(strict)))
    controls += rnd.sample(loose, max(0, N_CTL - len(controls)))
    sel = {'positives': rnd.sample(pos, min(N_POS, len(pos))), 'controls': controls}
    json.dump(sel, open(os.path.join(ROOT, 'selection.json'), 'w', encoding='utf-8'), indent=0)
    print('videos in dump', len(vids), '| positive pool', len(pos), '| selected', len(sel['positives']), 'positives,', len(sel['controls']), 'controls')


if __name__ == '__main__':
    sys.exit(main())
