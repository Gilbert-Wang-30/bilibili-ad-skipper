// Deno test helper: evaluates the extension's pure content modules into globalThis.BAS.
// Usage (inside a test):  import { loadBAS, loadFixture, loadFullFixture } from './load.js';
const here = new URL('.', import.meta.url);
const SRC = new URL('../src/content/', here);

const PURE_MODULES = [
  '00-ns.js',
  '10-storage.js',
  '20-protobuf.js',
  '21-wbi.js',
  '30-detect-chapters.js',
  '31-detect-danmaku.js',
  '34-detect-heat.js',
  '35-skip-here.js',
  '36-media-probe.js',
  '37-av-segment.js',
  '33-fusion.js',
  '38-pipeline.js',
  '40-skipper.js',
];

let loaded = null;
export function loadBAS(modules = PURE_MODULES) {
  if (loaded) return loaded;
  delete globalThis.BAS;
  for (const m of modules) {
    const path = new URL(m, SRC);
    let src;
    try { src = Deno.readTextFileSync(path); } catch (e) { throw new Error(`cannot read ${path}: ${e.message}`); }
    try { new Function(src)(); } catch (e) { throw new Error(`error evaluating ${m}: ${e && e.stack || e}`); }
  }
  if (!globalThis.BAS) throw new Error('00-ns.js did not define globalThis.BAS');
  loaded = globalThis.BAS;
  return loaded;
}

export function fixturesDir(full = false) {
  return new URL(full ? './fixtures-full/' : './fixtures/', here);
}

/** Filtered fixture: {bvid, aid, cid, title, duration, owner, view_points, total, density5, dm:[[t,text,(action)]]} */
export function loadFixture(bvid) {
  return JSON.parse(Deno.readTextFileSync(new URL(`${bvid}.json`, fixturesDir(false))));
}
/** Full fixture (every danmaku): {bvid, aid, cid, title, duration, owner, view_points, dm:[[t,text,(action)]]} */
export function loadFullFixture(bvid) {
  return JSON.parse(Deno.readTextFileSync(new URL(`${bvid}.json`, fixturesDir(true))));
}
export function listFixtures(full = false) {
  const out = [];
  for (const e of Deno.readDirSync(fixturesDir(full))) if (e.isFile && /^BV\w+\.json$/.test(e.name)) out.push(e.name.replace(/\.json$/, ''));
  return out.sort();
}
/** Convert fixture rows to Danmaku[] as the extension produces them. */
export function toDanmaku(rows) {
  return rows.map((r) => (r[2] ? { t: r[0], text: r[1], action: r[2] } : { t: r[0], text: r[1] }));
}
export function loadExpected() {
  return JSON.parse(Deno.readTextFileSync(new URL('expected.json', fixturesDir(false))));
}

/** True when the private real-danmaku corpus (test/fixtures-full/, not distributed) is present. */
export function hasFullFixtures() {
  try { for (const e of Deno.readDirSync(fixturesDir(true))) if (e.isFile && /^BV\w+\.json$/.test(e.name)) return true; } catch (_) { /* missing */ }
  return false;
}
/** Public chapter-only fixture (uploader chapter list, no danmaku). */
export function loadChapterFixture(bvid) {
  return JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/public/${bvid}.chapters.json`, here)));
}

/** Private A/V feature windows (test/fixtures-full/av/, numbers computed from the video's own streams; not distributed). */
export function hasAvFixtures() {
  try { for (const e of Deno.readDirSync(new URL('./fixtures-full/av/', here))) if (e.isFile && e.name.endsWith('.json')) return true; } catch (_) { /* missing */ }
  return false;
}
/** Loads one exported window and converts its column arrays back to the probe's frame objects. */
export function loadAvFixture(name) {
  const d = JSON.parse(Deno.readTextFileSync(new URL(`./fixtures-full/av/${name}.json`, here)));
  return {
    t0: d.t0, t1: d.t1, duration: d.duration,
    audio: d.audio.map((r) => ({ t: r[0], db: r[1], centroid: r[2], flatness: r[3], flux: r[4] / 1000, zcr: r[5] })),
    video: d.video.map((r) => ({ t: r[0], mean: r[1], std: r[2], sat: r[3], colorful: r[4], edge: r[5], cut: r[6], drift: r[7] })),
  };
}
