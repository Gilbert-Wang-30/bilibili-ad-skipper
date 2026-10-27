// Tests for src/background.js: install / update keeps the user's settings, and removes what v1.0.0 (which sent the
// subtitles to an AI model with the user's API key) left behind.
import { assert, assertEquals } from './assert.js';

const SRC = Deno.readTextFileSync(new URL('../src/background.js', import.meta.url));

function fakeChrome(local, sync, session) {
  const area = (data) => ({
    get: async (k) => (k == null ? Object.assign({}, data) : typeof k === 'string' ? (k in data ? { [k]: data[k] } : {}) : Object.fromEntries(Object.keys(k).map((x) => [x, x in data ? data[x] : k[x]]))),
    set: async (o) => { Object.assign(data, o); },
    remove: async (ks) => { for (const k of [].concat(ks)) delete data[k]; },
  });
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  return {
    listeners,
    chrome: {
      storage: { local: area(local), sync: area(sync), session: area(session) },
      runtime: { onInstalled: ev('installed'), onMessage: ev('message'), getManifest: () => ({ version: '2.0.0' }), openOptionsPage: () => {} },
      action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
      permissions: { contains: async () => true },
      tabs: { onRemoved: ev('tabRemoved') },
    },
  };
}

Deno.test('background: an update from v1.0.0 deletes the API key, the AI settings and the AI answer cache', async () => {
  const local = { llmConfig: { provider: 'x', keyHint: '…1234' }, 'a:111': { reads: [] }, 'a:222': { reads: [] }, 'c:333': { v: 1 }, 'v:BV1:1': { ignore: [] } };
  const sync = { settings: { enabled: true, mode: 'manual', useLlm: true, minConfidence: 0.7 } };
  const session = { llmBudget: { n: 3 } };
  const deleted = [];
  const { chrome, listeners } = fakeChrome(local, sync, session);
  new Function('chrome', 'indexedDB', SRC)(chrome, { deleteDatabase: (name) => { deleted.push(name); } });
  await listeners.installed({ reason: 'update', previousVersion: '1.0.0' });
  assertEquals(deleted, ['bas-secrets']);
  assertEquals(Object.keys(local).sort(), ['c:333', 'v:BV1:1']);
  assert(!('llmBudget' in session), 'session budget removed');
  assertEquals(sync.settings.useLlm, undefined);
  assertEquals([sync.settings.mode, sync.settings.minConfidence, sync.settings.useSubtitles], ['manual', 0.7, true]);
});

Deno.test('background: the cleanup never throws without IndexedDB or session storage', async () => {
  const local = { 'a:1': {}, 'c:2': {} };
  const sync = { settings: { useLlm: false } };
  const { chrome, listeners } = fakeChrome(local, sync, {});
  delete chrome.storage.session;
  new Function('chrome', 'indexedDB', SRC)(chrome, undefined);
  await listeners.installed({ reason: 'update' });
  assertEquals(Object.keys(local), ['c:2']);
  assertEquals(sync.settings.useLlm, undefined);
});

Deno.test('background: a fresh install writes the defaults, the same as the content script\'s', async () => {
  const sync = {};
  const { chrome, listeners } = fakeChrome({}, sync, {});
  new Function('chrome', 'indexedDB', SRC)(chrome, { deleteDatabase: () => {} });
  await listeners.installed({ reason: 'install' });
  delete globalThis.BAS;
  new Function(Deno.readTextFileSync(new URL('../src/content/00-ns.js', import.meta.url)))();
  assertEquals(sync.settings, globalThis.BAS.DEFAULT_SETTINGS);
});
