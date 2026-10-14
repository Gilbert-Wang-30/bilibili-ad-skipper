// Load-time safety for 41-ui.js: must evaluate without `document`, define BAS.ui, and every API
// call must be a no-op (never throw) when there is no DOM.
import { loadBAS } from './load.js';

// tiny local asserts (no network imports in tests)
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEquals(a, b, msg) { if (a !== b) throw new Error((msg ? msg + ': ' : '') + `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const BAS = loadBAS(['00-ns.js', '41-ui.js']);

Deno.test('41-ui defines BAS.ui with the SPEC §9 surface', () => {
  assert(BAS.ui, 'BAS.ui missing');
  for (const k of ['mount', 'refresh', 'renderMarkers', 'showToast', 'showSkipButton', 'hideSkipButton', 'setBadge', 'destroy']) {
    assertEquals(typeof BAS.ui[k], 'function', `BAS.ui.${k}`);
  }
  assertEquals(BAS.ui.COLORS.chapter, '#ff7a45');
  assertEquals(BAS.ui.COLORS.danmaku, '#fb7299');
  assertEquals(BAS.ui.COLORS.user, '#52c41a');
});

Deno.test('41-ui API is a safe no-op without a DOM', () => {
  assertEquals(typeof document, 'undefined');
  assertEquals(BAS.ui.mount(), false);
  assertEquals(BAS.ui.refresh(), false);
  BAS.ui.renderMarkers([{ start: 1, end: 5, source: 'chapter', confidence: 1, reason: 'x' }], 100);
  const h = BAS.ui.showToast({ text: 'hi', actionLabel: '撤销', onAction() {} });
  assertEquals(typeof h.close, 'function');
  h.close();
  BAS.ui.showSkipButton({ label: '跳过广告 ▶', sub: '1:23 → 2:45', onClick() {} });
  BAS.ui.hideSkipButton();
  BAS.ui.setBadge(3);
  assertEquals(BAS.ui.isMounted(), false);
  BAS.ui.destroy();
});

Deno.test('41-ui is idempotent when evaluated twice', () => {
  const first = BAS.ui;
  const src = Deno.readTextFileSync(new URL('../src/content/41-ui.js', import.meta.url));
  new Function(src)();
  assert(BAS.ui === first, 'second evaluation replaced BAS.ui');
});
