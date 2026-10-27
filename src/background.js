/* Bilibili Ad Skipper — MV3 service worker. Stateless: fetch proxy for api.bilibili.com, defaults, per-tab badge. */

const DEFAULT_SETTINGS = {
  enabled: true, mode: 'auto', minConfidence: 0.6,
  useChapters: true, useDanmaku: true, useMedia: true, useAudio: false, useHeat: true, useCrowd: true, useSubtitles: true, useAvProbe: true, skipHereMedia: false, skipHereButton: true,
  showMarkers: true, showToast: true, toastDurationMs: 6000, landingOffsetSec: 0,
  extraStartKeywords: [], extraEndKeywords: [], ignoreUps: [], debug: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    else {
      const next = Object.assign({}, DEFAULT_SETTINGS, settings);
      if (settings.skipHereMedia === undefined && settings.useAvProbe === false) next.skipHereMedia = false;   // keep an A/V opt-out
      delete next.useLlm;   // v1.0.0's AI setting
      await chrome.storage.sync.set({ settings: next });
    }
  } catch (e) { console.warn('[BAS bg] init settings failed', e); }
  // v1.0.0 sent the subtitles to an AI model with the user's API key; v2 has no AI. Remove everything it stored: the
  // key (IndexedDB 'bas-secrets'), its settings, its answer cache ('a:<cid>') and the session budget.
  try { indexedDB.deleteDatabase('bas-secrets'); } catch (e) { /* ignore */ }
  try {
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all || {}).filter((k) => k.startsWith('a:') || k === 'llmConfig');
    if (old.length) await chrome.storage.local.remove(old);
  } catch (e) { /* ignore */ }
  try { if (chrome.storage.session) await chrome.storage.session.remove('llmBudget'); } catch (e) { /* ignore */ }
  try { await chrome.action.setBadgeBackgroundColor({ color: '#fb7299' }); } catch (e) { /* ignore */ }
});

const ALLOWED = /^https:\/\/(?:api\.bilibili\.com\/|bvc\.bilivideo\.com\/pbp\/data\?|bsbsb\.top\/api\/skipSegments\/[0-9a-f]{4}\?)/;
// third-party lookups never carry cookies
const THIRD_PARTY = /^https:\/\/bsbsb\.top\//;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'BAS_FETCH') {
    (async () => {
      try {
        if (!ALLOWED.test(msg.url)) { sendResponse({ ok: false, error: 'url not allowed' }); return; }
        const third = THIRD_PARTY.test(msg.url);
        const init = third
          ? { credentials: 'omit', cache: 'no-store', headers: { 'x-ext-version': 'bilibili-ad-skipper/' + chrome.runtime.getManifest().version } }
          : { credentials: 'include', cache: 'no-store' };
        const resp = await fetch(msg.url, init);
        if (msg.responseType === 'arraybuffer') {
          const buf = await resp.arrayBuffer();
          sendResponse({ ok: resp.ok, status: resp.status, b64: bufToB64(buf) });
        } else {
          const text = await resp.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* not json */ }
          sendResponse({ ok: resp.ok, status: resp.status, json, text: json ? undefined : text.slice(0, 2000) });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  if (msg.type === 'BAS_PING') {
    // the content script checks that the running manifest matches its files (an unpacked extension that was updated
    // but not reloaded runs new files under the old manifest) and that the crowd lookup is allowed
    (async () => {
      let crowd = null;
      try { crowd = await chrome.permissions.contains({ origins: ['https://bsbsb.top/*'] }); } catch (e) { crowd = null; }
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, crowdPermission: crowd });
    })();
    return true;
  }

  if (msg.type === 'BAS_BADGE') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      const n = Number(msg.count) || 0;
      chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#fb7299' }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'BAS_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
