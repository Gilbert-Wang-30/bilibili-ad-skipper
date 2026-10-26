// Tests for the popup / options pages: CSP hygiene of the HTML, syntax of the scripts when `chrome` is
// undefined, and the pure helpers each script exposes in that situation.
import { strict as A } from 'node:assert';
const assert = (c, m) => A.ok(c, m);
const assertEquals = (a, b, m) => A.deepEqual(a, b, m);
const assertThrows = (fn) => A.throws(fn);

const here = new URL('.', import.meta.url);
const read = (rel) => Deno.readTextFileSync(new URL(rel, here));

const POPUP_HTML = read('../src/popup/popup.html');
const POPUP_JS = read('../src/popup/popup.js');
const OPTIONS_HTML = read('../src/options/options.html');
const OPTIONS_JS = read('../src/options/options.js');
const NS_JS = read('../src/content/00-ns.js');

function checkHtml(html, scriptName) {
  assert(/<html lang="zh-CN">/.test(html), 'lang zh-CN');
  assert(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
  assert(!/javascript:/i.test(html), 'no javascript: URLs');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length >= 1, 'a script tag');
  for (const sc of scripts) {
    assert(/\ssrc="(?!https?:)[^"]+\.js"/.test(sc[1]), 'every script is a local file: ' + sc[0]);
    assertEquals(sc[2].trim(), '', 'script body is empty');
  }
  assert(new RegExp(`src="${scriptName}"`).test(scripts[scripts.length - 1][1]), 'the page script comes last');
  assert(!/<style[\s>]/i.test(html), 'no inline <style> (keep CSS in the .css file)');
  // example text may name this machine (an Ollama address); nothing else may point off the extension
  assert(!/https?:\/\/(?!space\.bilibili\.com|localhost[:/])/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no remote resources');
  for (const m of html.matchAll(/<button\b([^>]*)>/gi)) assert(/type="button"/.test(m[1]), 'every <button> has type="button": ' + m[0]);
}

Deno.test('popup.html is CSP-clean', () => checkHtml(POPUP_HTML, 'popup.js'));
Deno.test('options.html is CSP-clean', () => checkHtml(OPTIONS_HTML, 'options.js'));

Deno.test('popup.html has the required controls', () => {
  for (const id of ['enabled', 'modeCtrl', 'videoTitle', 'status', 'segList', 'droppedToggle', 'droppedList', 'markStart', 'markEnd', 'rescan', 'clearOverrides', 'openOptions']) {
    assert(new RegExp(`id="${id}"`).test(POPUP_HTML), 'missing #' + id);
  }
  for (const s of ['自动跳过', '手动按钮', '标记广告开始', '标记广告结束', '重新检测', '清除本视频覆盖', '设置']) assert(POPUP_HTML.includes(s), 'missing text ' + s);
  assert(/width:\s*340px/.test(read('../src/popup/popup.css')), 'popup width 340px');
});

Deno.test('options.html has a control for every setting', () => {
  const defaults = { enabled: 1, mode: 1, minConfidence: 1, useChapters: 1, useDanmaku: 1, useMedia: 1, useAudio: 1, useHeat: 1, useCrowd: 1, useAvProbe: 1, skipHereMedia: 1, skipHereButton: 1, showMarkers: 1, showToast: 1, toastDurationMs: 1, landingOffsetSec: 1, extraStartKeywords: 1, extraEndKeywords: 1, ignoreUps: 1, debug: 1 };
  for (const k of Object.keys(defaults)) assert(new RegExp(`name="${k}"`).test(OPTIONS_HTML), 'missing control for ' + k);
  assert(/name="minConfidence" min="0.3" max="0.9" step="0.05"/.test(OPTIONS_HTML));
  assert(/name="landingOffsetSec" min="-5" max="10"/.test(OPTIONS_HTML));
  for (const id of ['resetBtn', 'exportBtn', 'importBtn', 'importFile', 'clearCacheBtn', 'saved']) assert(new RegExp(`id="${id}"`).test(OPTIONS_HTML), 'missing #' + id);
  for (const s of ['恢复默认', '导出设置', '导入设置', '清除缓存与覆盖', '已保存']) assert(OPTIONS_HTML.includes(s), 'missing text ' + s);
});

Deno.test('popup.js / options.js parse and load with chrome undefined', () => {
  assertEquals(typeof globalThis.chrome, 'undefined');
  new Function(POPUP_JS)();
  new Function(OPTIONS_JS)();
  assert(globalThis.__BAS_POPUP_TEST__, 'popup exposed test helpers');
  assert(globalThis.__BAS_OPTIONS_TEST__, 'options exposed test helpers');
});

Deno.test('DEFAULT_SETTINGS copies match 00-ns.js', () => {
  delete globalThis.BAS;
  new Function(NS_JS)();
  new Function(POPUP_JS)();
  new Function(OPTIONS_JS)();
  const ns = globalThis.BAS.DEFAULT_SETTINGS;
  assertEquals(globalThis.__BAS_POPUP_TEST__.DEFAULT_SETTINGS, ns);
  assertEquals(globalThis.__BAS_OPTIONS_TEST__.DEFAULT_SETTINGS, ns);
});

Deno.test('popup helpers', () => {
  new Function(POPUP_JS)();
  const P = globalThis.__BAS_POPUP_TEST__;
  assertEquals(P.fmtTime(0), '0:00');
  assertEquals(P.fmtTime(254.7), '4:14');
  assertEquals(P.fmtTime(3725), '1:02:05');
  assertEquals(P.fmtRange(252, 360), '4:12–6:00');
  assertEquals(P.fmtRange(252, null), '4:12–?');
  assertEquals(P.pct(0.954), '95%');
  assertEquals(P.pct('x'), '—');
  assertEquals(P.sourcesOf({ source: 'danmaku' }), ['danmaku']);
  assertEquals(P.sourcesOf({ source: 'chapter', sources: ['chapter', 'danmaku', 'bogus', 'danmaku'] }), ['chapter', 'danmaku']);
  assert(P.isVideoUrl('https://www.bilibili.com/video/BV1jCJs6UE9S/?p=2'));
  assert(P.isVideoUrl('https://www.bilibili.com/list/ml123'));
  assert(!P.isVideoUrl('https://www.bilibili.com/'));
  assert(!P.isVideoUrl('https://space.bilibili.com/123'));
  assert(!P.isVideoUrl(undefined));
  const merged = P.mergeSettings({ mode: 'manual', junk: 1 });
  assertEquals(merged.mode, 'manual');
  assertEquals(merged.enabled, true);
  assertEquals('junk' in merged, false);

  assertEquals(P.statusText(null).text, '请在 B 站视频页使用');
  assertEquals(P.statusText({ kind: 'notVideo' }).text, '请在 B 站视频页使用');
  assertEquals(P.statusText({ kind: 'noReceiver' }).text, '页面脚本未就绪，请刷新');
  assertEquals(P.statusText({ kind: 'ok', state: { status: 'loading', segments: [] } }).text, '检测中…');
  assertEquals(P.statusText({ kind: 'ok', state: { status: 'ready', segments: [] } }).text, '未检测到广告');
  assertEquals(P.statusText({ kind: 'ok', state: { status: 'ready', segments: [{}, {}] } }).text, '已检测到 2 段广告');
  assertEquals(P.statusText({ kind: 'ok', state: { status: 'ignored' } }).text, '已忽略该 UP 主');
  assert(P.statusText({ kind: 'ok', state: { status: 'error', error: 'boom' } }).text.includes('boom'));

  const segs = [{ id: 'd:1-2', start: 1, end: 2, enabled: true, autoSkip: true, confidence: 0.9 }];
  const k1 = P.listKey(segs, []);
  assertEquals(k1, P.listKey(segs.map((s) => ({ ...s })), []));
  assert(k1 !== P.listKey([{ ...segs[0], enabled: false }], []));
  assert(k1 !== P.listKey(segs, [{ start: 5, end: null, confidence: 0.3 }]));
});

Deno.test('options helpers: ignoreUps normalization', () => {
  new Function(OPTIONS_JS)();
  const O = globalThis.__BAS_OPTIONS_TEST__;
  assertEquals(O.parseMid('123456'), '123456');
  assertEquals(O.parseMid('https://space.bilibili.com/654321'), '654321');
  assertEquals(O.parseMid('https://space.bilibili.com/654321/video?spm_id_from=x'), '654321');
  assertEquals(O.parseMid('space.bilibili.com/77'), '77');
  assertEquals(O.parseMid('UID:42'), '42');
  assertEquals(O.parseMid('uid：42'), '42');
  assertEquals(O.parseMid('abc'), null);
  assertEquals(O.parseMid('12ab'), null);
  assertEquals(O.parseMid(''), null);
  assertEquals(
    O.normalizeIgnoreUps('123456\nhttps://space.bilibili.com/654321  77, 123456\n\nabc 0'),
    ['123456', '654321', '77'],
  );
  assertEquals(O.normalizeIgnoreUps([946974, '946974', 'https://space.bilibili.com/1']), ['946974', '1']);
  assertEquals(O.normalizeIgnoreUps(null), []);
});

Deno.test('options helpers: sanitizeSettings / import / export', () => {
  new Function(OPTIONS_JS)();
  const O = globalThis.__BAS_OPTIONS_TEST__;
  assertEquals(O.sanitizeSettings(null), O.DEFAULT_SETTINGS);
  assertEquals(O.sanitizeSettings({}), O.DEFAULT_SETTINGS);

  const s = O.sanitizeSettings({
    enabled: 'false', mode: 'weird', minConfidence: '1.5', toastDurationMs: 10, landingOffsetSec: -99,
    extraStartKeywords: ' 恰饭时间 \n\n恰饭时间\n本期赞助', extraEndKeywords: ['安全着陆', 7],
    ignoreUps: '1 https://space.bilibili.com/2', debug: true, unknownKey: 'x',
  });
  assertEquals(s.enabled, false);
  assertEquals(s.mode, 'auto');
  assertEquals(s.minConfidence, 0.9);
  assertEquals(s.toastDurationMs, 1000);
  assertEquals(s.landingOffsetSec, -5);
  assertEquals(s.extraStartKeywords, ['恰饭时间', '本期赞助']);
  assertEquals(s.extraEndKeywords, ['安全着陆', '7']);
  assertEquals(s.ignoreUps, ['1', '2']);
  assertEquals(s.debug, true);
  assertEquals('unknownKey' in s, false);
  assertEquals(Object.keys(s).sort(), Object.keys(O.DEFAULT_SETTINGS).sort());

  // Import accepts an envelope or a bare object; rejects garbage.
  const env = O.exportEnvelope({ ...O.DEFAULT_SETTINGS, mode: 'manual' }, '0.1.0');
  assertEquals(env.app, 'bilibili-ad-skipper');
  assertEquals(env.version, '0.1.0');
  assertEquals(O.settingsFromImport(JSON.parse(JSON.stringify(env))).mode, 'manual');
  assertEquals(O.settingsFromImport({ minConfidence: 0.75 }).minConfidence, 0.75);
  assertThrows(() => O.settingsFromImport({ foo: 1 }));
  assertThrows(() => O.settingsFromImport('nope'));
  assertThrows(() => O.settingsFromImport(null));

  assertEquals(O.fmtPct(0.6), '60%');
  assertEquals(O.fmtOffset(0), '0 秒');
  assertEquals(O.fmtOffset(2.5), '+2.5 秒');
  assertEquals(O.fmtOffset(-1), '-1 秒');
});
