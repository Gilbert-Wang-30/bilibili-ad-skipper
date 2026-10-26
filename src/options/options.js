/* Bilibili Ad Skipper — options page. Plain script, no inline handlers (MV3 CSP).
 * Settings live in chrome.storage.sync under key 'settings', merged over DEFAULT_SETTINGS. */
(() => {
  'use strict';

  // Copy of BAS.DEFAULT_SETTINGS (options page cannot load 00-ns.js).
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'auto',
    minConfidence: 0.6,
    useChapters: true,
    useDanmaku: true,
    useMedia: true,
    useAudio: false,
    useHeat: true,
    useCrowd: true,
    useSubtitles: true,
    useLlm: true,
    useAvProbe: true,
    skipHereMedia: false,
    skipHereButton: true,
    showMarkers: true,
    showToast: true,
    toastDurationMs: 6000,
    landingOffsetSec: 0,
    extraStartKeywords: [],
    extraEndKeywords: [],
    ignoreUps: [],
    debug: false,
  };

  const LIMITS = {
    minConfidence: [0.3, 0.9],
    toastDurationMs: [1000, 20000],
    landingOffsetSec: [-5, 10],
  };
  // chrome.storage.sync allows 8 KB per item and settings are one item; worst case below (UTF-8, 3 bytes per CJK char):
  // 2 × 30 × 20 × 3 ≈ 3.6 KB keywords + 300 × ~12 B ≈ 3.6 KB mids + ~0.4 KB other fields < 8 KB.
  const MAX_KEYWORDS = 30;
  const MAX_KEYWORD_LEN = 20;
  const MAX_UPS = 300;

  // ---------- pure helpers ----------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  /** Textarea text → trimmed, de-duplicated, non-empty lines. */
  function parseLines(text, maxLen) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
      let s = raw.trim();
      if (!s) continue;
      if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  /** One token → numeric mid string or null. Accepts '123', 'uid:123', 'space.bilibili.com/123?...', 'https://space.bilibili.com/123/video'. */
  function parseMid(token) {
    const s = String(token || '').trim();
    if (!s) return null;
    let m = /space\.bilibili\.com\/(\d{1,20})/i.exec(s);
    if (m) return m[1];
    m = /^(?:uid|mid)\s*[:：=]?\s*(\d{1,20})$/i.exec(s);
    if (m) return m[1];
    m = /^(\d{1,20})$/.exec(s);
    if (m) return m[1];
    return null;
  }

  /** Free text (lines / spaces / commas) → unique numeric mid strings, in input order. */
  function normalizeIgnoreUps(input) {
    const tokens = Array.isArray(input) ? input.map(String) : String(input || '').split(/[\s,，;；]+/);
    const out = [];
    const seen = new Set();
    for (const t of tokens) {
      const mid = parseMid(t);
      if (!mid || mid === '0' || seen.has(mid)) continue;
      seen.add(mid);
      out.push(mid);
      if (out.length >= MAX_UPS) break;
    }
    return out;
  }

  const toNum = (v, def) => { const n = typeof v === 'string' ? parseFloat(v) : Number(v); return isFinite(n) ? n : def; };
  const toBool = (v, def) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : def);
  function toStrList(v, maxLen) {
    if (Array.isArray(v)) return parseLines(v.map((x) => String(x)).join('\n'), maxLen).slice(0, MAX_KEYWORDS);
    if (typeof v === 'string') return parseLines(v, maxLen).slice(0, MAX_KEYWORDS);
    return [];
  }

  /** Coerce an arbitrary object (storage, import file) into a valid settings object. Unknown keys are dropped. */
  function sanitizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const d = DEFAULT_SETTINGS;
    const out = {
      enabled: toBool(src.enabled, d.enabled),
      mode: src.mode === 'manual' ? 'manual' : 'auto',
      minConfidence: clamp(toNum(src.minConfidence, d.minConfidence), LIMITS.minConfidence[0], LIMITS.minConfidence[1]),
      useChapters: toBool(src.useChapters, d.useChapters),
      useDanmaku: toBool(src.useDanmaku, d.useDanmaku),
      useMedia: toBool(src.useMedia, d.useMedia),
      useAudio: toBool(src.useAudio, d.useAudio),
      useHeat: toBool(src.useHeat, d.useHeat),
      useCrowd: toBool(src.useCrowd, d.useCrowd),
      useSubtitles: toBool(src.useSubtitles, d.useSubtitles),
      useLlm: toBool(src.useLlm, d.useLlm),
      useAvProbe: toBool(src.useAvProbe, d.useAvProbe),
      skipHereMedia: toBool(src.skipHereMedia, d.skipHereMedia),
      skipHereButton: toBool(src.skipHereButton, d.skipHereButton),
      showMarkers: toBool(src.showMarkers, d.showMarkers),
      showToast: toBool(src.showToast, d.showToast),
      toastDurationMs: Math.round(clamp(toNum(src.toastDurationMs, d.toastDurationMs), LIMITS.toastDurationMs[0], LIMITS.toastDurationMs[1])),
      landingOffsetSec: clamp(toNum(src.landingOffsetSec, d.landingOffsetSec), LIMITS.landingOffsetSec[0], LIMITS.landingOffsetSec[1]),
      extraStartKeywords: toStrList(src.extraStartKeywords, MAX_KEYWORD_LEN),
      extraEndKeywords: toStrList(src.extraEndKeywords, MAX_KEYWORD_LEN),
      ignoreUps: normalizeIgnoreUps(src.ignoreUps),
      debug: toBool(src.debug, d.debug),
    };
    out.minConfidence = Math.round(out.minConfidence * 100) / 100;
    out.landingOffsetSec = Math.round(out.landingOffsetSec * 10) / 10;
    return out;
  }

  /** Accept either an export envelope {settings:{...}} or a bare settings object. */
  function settingsFromImport(json) {
    if (!json || typeof json !== 'object') throw new Error('not an object');
    const body = json.settings && typeof json.settings === 'object' ? json.settings : json;
    const known = Object.keys(DEFAULT_SETTINGS).filter((k) => k in body);
    if (known.length === 0) throw new Error('no known settings keys');
    return sanitizeSettings(body);
  }

  function exportEnvelope(settings, version) {
    return { app: 'bilibili-ad-skipper', version: version || '', exportedAt: new Date().toISOString(), settings: sanitizeSettings(settings) };
  }

  const fmtPct = (v) => Math.round(v * 100) + '%';
  const fmtOffset = (v) => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' 秒';

  // Expose pure helpers for Deno tests when running outside the extension.
  if (typeof chrome === 'undefined' || !chrome.storage) {
    globalThis.__BAS_OPTIONS_TEST__ = { DEFAULT_SETTINGS, parseLines, parseMid, normalizeIgnoreUps, sanitizeSettings, settingsFromImport, exportEnvelope, fmtPct, fmtOffset };
    return;
  }

  // ---------- storage ----------
  async function loadSettings() {
    try {
      const r = await chrome.storage.sync.get('settings');
      return sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, r && r.settings));
    } catch (e) { return sanitizeSettings(DEFAULT_SETTINGS); }
  }
  async function writeSettings(settings) {
    await chrome.storage.sync.set({ settings: sanitizeSettings(settings) });
  }

  // ---------- UI ----------
  const $ = (id) => document.getElementById(id);
  const form = () => $('form');
  const field = (name) => form().elements.namedItem(name);

  let current = sanitizeSettings(DEFAULT_SETTINGS);
  let savedTimer = null;
  let toastTimer = null;
  let debounceTimer = null;
  let applying = false;

  function showSaved() {
    const el = $('saved');
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }
  function showToast(text, ms = 2200) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function updateOutputs() {
    $('minConfidenceOut').textContent = fmtPct(toNum(field('minConfidence').value, current.minConfidence));
    $('landingOffsetSecOut').textContent = fmtOffset(toNum(field('landingOffsetSec').value, current.landingOffsetSec));
  }

  /** Settings object → form controls. */
  function applyToForm(s) {
    applying = true;
    try {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const el = field(k);
        if (!el) continue;
        const v = s[k];
        if (el.type === 'checkbox') el.checked = !!v;
        else if (Array.isArray(v)) el.value = v.join('\n');
        else el.value = String(v);
      }
      updateOutputs();
    } finally { applying = false; }
  }

  /** Form controls → sanitized settings object. */
  function readForm() {
    const raw = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const el = field(k);
      if (!el) continue;
      raw[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return sanitizeSettings(raw);
  }

  async function save(opts) {
    const next = readForm();
    const normalizeUi = opts && opts.normalizeUi;
    try {
      await writeSettings(next);
      current = next;
      showSaved();
      if (normalizeUi) applyToForm(current);   // e.g. rewrite space links into bare mids after blur
    } catch (e) {
      showToast('保存失败：' + String(e && e.message || e).slice(0, 80));
    }
  }

  function scheduleSave(delayMs) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => save(), delayMs);
  }

  async function updateStorageInfo() {
    try {
      const all = await chrome.storage.local.get(null);
      let c = 0, v = 0, a = 0;
      for (const k of Object.keys(all || {})) { if (k.startsWith('c:')) c++; else if (k.startsWith('v:')) v++; else if (k.startsWith('a:')) a++; }
      $('storageInfo').textContent = `当前缓存：${c} 个视频的检测结果，${a} 个视频的 AI 分析结果，${v} 个视频的覆盖记录。`;
    } catch (e) { $('storageInfo').textContent = ''; }
  }

  async function clearCacheAndOverrides() {
    const btn = $('clearCacheBtn');
    btn.disabled = true;
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all || {}).filter((k) => k.startsWith('c:') || k.startsWith('v:') || k.startsWith('a:'));
      if (keys.length) await chrome.storage.local.remove(keys);
      showToast(`已清除 ${keys.length} 条缓存 / 覆盖记录`);
      await updateStorageInfo();
    } catch (e) {
      showToast('清除失败：' + String(e && e.message || e).slice(0, 80));
    } finally { btn.disabled = false; }
  }

  async function resetDefaults() {
    try {
      await writeSettings(DEFAULT_SETTINGS);
      current = sanitizeSettings(DEFAULT_SETTINGS);
      applyToForm(current);
      showSaved();
      showToast('已恢复默认设置');
    } catch (e) { showToast('操作失败'); }
  }

  function exportSettings() {
    try {
      const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
      const text = JSON.stringify(exportEnvelope(current, version), null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `bilibili-ad-skipper-settings-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { showToast('导出失败'); }
  }

  async function importSettingsFile(file) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('文件过大');
      const text = await file.text();
      const json = JSON.parse(text);
      const next = settingsFromImport(json);
      await writeSettings(next);
      current = next;
      applyToForm(current);
      showSaved();
      showToast('已导入设置');
    } catch (e) {
      showToast('导入失败：文件格式不正确');
    }
  }

  function wire() {
    const f = form();
    f.addEventListener('submit', (ev) => ev.preventDefault());

    // Immediate save for discrete controls; debounced for text fields.
    f.addEventListener('change', (ev) => {
      if (applying) return;
      const el = ev.target;
      if (!el || !el.name) return;
      if (el.tagName === 'TEXTAREA') { clearTimeout(debounceTimer); save({ normalizeUi: el.name === 'ignoreUps' }); }
      else save();
    });
    f.addEventListener('input', (ev) => {
      if (applying) return;
      const el = ev.target;
      if (!el || !el.name) return;
      if (el.type === 'range') { updateOutputs(); scheduleSave(250); }
      else if (el.tagName === 'TEXTAREA' || el.type === 'number') scheduleSave(600);
    });

    $('resetBtn').addEventListener('click', resetDefaults);
    $('exportBtn').addEventListener('click', exportSettings);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      importSettingsFile(file).finally(() => { ev.target.value = ''; });
    });
    $('clearCacheBtn').addEventListener('click', clearCacheAndOverrides);

    // Reflect changes made elsewhere (popup, another options tab).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.settings) {
          const next = sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue));
          if (JSON.stringify(next) === JSON.stringify(current)) return;
          current = next;
          if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return; // don't clobber typing
          applyToForm(current);
        }
        if (area === 'local') updateStorageInfo();
      });
    } catch (e) { /* ignore */ }

    window.addEventListener('unload', () => { clearTimeout(debounceTimer); clearTimeout(savedTimer); clearTimeout(toastTimer); });
  }

  // ---------- AI transcript check (model provider + key; chrome.storage.local, never synced or exported) ----------
  const LLM = window.BAS_LLM_PROVIDERS;
  const LLM_KEY = 'llmConfig';
  let llmStored = null;
  function setAiStatus(text, kind) {
    const el = $('aiStatus');
    el.textContent = text;
    el.className = 'help' + (kind === 'ok' ? ' ok-text' : kind === 'err' ? ' err-text' : '');
  }
  function aiProviderChanged() {
    const id = $('aiProvider').value, p = LLM.PROVIDERS[id] || {};
    const mine = llmStored && llmStored.provider === id;
    // the stored model / address belong to the stored provider only
    $('aiModel').value = mine && llmStored.model && llmStored.model !== p.model ? llmStored.model : '';
    $('aiBaseUrl').value = mine && id === 'custom' ? (llmStored.baseUrl || '') : '';
    $('aiModel').placeholder = p.model || '模型名，如 qwen2.5:7b';
    $('aiBaseRow').hidden = id !== 'custom';
    $('aiKey').placeholder = mine && llmStored.keyHint ? `已保存（…${llmStored.keyHint}），留空则不修改` : (p.keyHint || '');
    const hint = $('aiProviderHint');
    hint.textContent = (p.tested ? `已在本项目的测试集上测过。默认 ${p.model}（每个视频约 0.04 美元）；${p.altModel} 在测试集上同样准确，每个视频约 0.001 美元，可在「模型」里填写。` : '与推荐模型用同一提示词，准确率未在本项目测试。') + (p.keyUrl ? ' 获取密钥：' : '');
    if (p.keyUrl) { const a = document.createElement('a'); a.href = p.keyUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = new URL(p.keyUrl).host; hint.appendChild(a); }
  }
  async function loadAi() {
    if (!LLM) { $('aiCard').hidden = true; return; }
    const sel = $('aiProvider');
    for (const [id, p] of Object.entries(LLM.PROVIDERS)) { const o = document.createElement('option'); o.value = id; o.textContent = p.label + (p.tested ? '（推荐）' : ''); sel.appendChild(o); }
    try { llmStored = (await chrome.storage.local.get(LLM_KEY))[LLM_KEY] || null; } catch (e) { llmStored = null; }
    sel.value = llmStored && LLM.PROVIDERS[llmStored.provider] ? llmStored.provider : 'anthropic';
    aiProviderChanged();
    let key = '';
    try { key = (await LLM.getSecret('apiKey')) || ''; } catch (e) { key = ''; }
    const cfg = LLM.normalizeConfig(llmStored && Object.assign({}, llmStored, { apiKey: key }));
    let permitted = false;
    if (cfg) { try { permitted = await chrome.permissions.contains({ origins: [LLM.originPattern(cfg)] }); } catch (e) { permitted = false; } }
    if (cfg && permitted) setAiStatus(`已设置：${cfg.label} · ${cfg.model}`, 'ok');
    else if (cfg) setAiStatus(`已设置 ${cfg.label}，但扩展没有访问 ${cfg.origin} 的权限：请点「保存并测试」重新授权。`, 'err');
    else setAiStatus('未设置。');
  }
  /** Small transcript with one obvious read: proves key, permission, model and reply format end to end. */
  const TEST_LINES = ['今天我们来聊聊黑洞是怎么形成的', '恒星燃料耗尽之后会发生坍缩', '说到熬夜看视频', '最近我一直在用小象家的护眼台灯', '评论区置顶链接就能领券下单', '好了我们回到正题', '坍缩到一定程度就形成了黑洞'];
  /** Origins of model services this extension holds an optional permission for (the required hosts excluded). */
  async function grantedLlmOrigins() {
    const required = new Set((chrome.runtime.getManifest().host_permissions || []));
    try { return ((await chrome.permissions.getAll()).origins || []).filter((o) => !required.has(o)); } catch (e) { return []; }
  }
  async function saveAi() {
    const provider = $('aiProvider').value;
    const p = LLM.PROVIDERS[provider];
    const typedKey = $('aiKey').value.trim();
    const raw = { provider, model: $('aiModel').value.trim() || p.model, baseUrl: provider === 'custom' ? $('aiBaseUrl').value.trim() : p.baseUrl };
    // a saved key is kept only for the same provider at the same address: it never follows a changed base URL
    let storedKey = '';
    try { storedKey = (await LLM.getSecret('apiKey')) || ''; } catch (e) { storedKey = ''; }
    const prev = llmStored ? LLM.normalizeConfig(Object.assign({}, llmStored, { apiKey: storedKey || 'x' })) : null;
    const probe = LLM.normalizeConfig(Object.assign({}, raw, { apiKey: 'x' }));
    const keepKey = !typedKey && prev && probe && prev.provider === provider && prev.origin === probe.origin ? storedKey : '';
    raw.apiKey = typedKey || keepKey || '';
    const cfg = LLM.normalizeConfig(raw);
    if (!cfg) { setAiStatus(!raw.apiKey && !p.keyOptional ? '请填写 API 密钥。' : !raw.model ? '请填写模型名。' : '接口地址无效（只接受 https，或本机的 http://localhost）。', 'err'); return; }
    // the permission prompt needs the click's user gesture: ask before anything else is awaited
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [LLM.originPattern(cfg)] }); } catch (e) { granted = false; }
    if (!granted) { setAiStatus('需要允许扩展访问 ' + cfg.origin + ' 才能调用模型。', 'err'); return; }
    if (raw.apiKey) await LLM.setSecret('apiKey', raw.apiKey); else await LLM.deleteSecret('apiKey');
    const stored = { provider: raw.provider, model: raw.model, baseUrl: raw.baseUrl, keyHint: raw.apiKey ? raw.apiKey.slice(-4) : '', rev: Date.now() };
    await chrome.storage.local.set({ [LLM_KEY]: stored });
    llmStored = stored;
    // access to a service no longer used is given back
    for (const o of await grantedLlmOrigins()) if (o !== LLM.originPattern(cfg)) { try { await chrome.permissions.remove({ origins: [o] }); } catch (e) { /* ignore */ } }
    $('aiKey').value = '';
    aiProviderChanged();
    setAiStatus('已保存，正在测试…');
    const ok = await testAi();
    if (ok) setAiStatus(`已设置并测试通过：${cfg.label} · ${cfg.model}（${ok}）`, 'ok');
  }
  async function testAi() {
    try {
      if (!window.BAS) window.BAS = {};
      if (!window.BAS.detectLlm) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '../content/29-detect-llm.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const L = window.BAS.detectLlm;
      // a realistic video length: the read is lines 2–5 of a 10-minute talk, not half of a 30 s clip
      const req = L.buildRequest({ title: '测试：黑洞', duration: 600, lines: TEST_LINES.map((t, i) => ({ from: i * 4, to: i * 4 + 3.5, content: t })) });
      const t0 = Date.now();
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'BAS_LLM', request: { system: req.system, user: req.user, schema: req.schema } }, (x) => { void chrome.runtime.lastError; res(x || null); }));
      if (!r || !r.ok) { setAiStatus('测试失败：' + ((r && r.error) || '后台没有响应'), 'err'); return null; }
      const parsed = L.parseReply(r.text, req);
      if (parsed.error) { setAiStatus('测试失败：' + parsed.error, 'err'); return null; }
      const hit = parsed.candidates.some((c) => c.start <= 12 && c.end >= 19);
      if (!hit) { setAiStatus('模型能连通，但没有认出测试字幕里的广告（换个模型试试）。', 'err'); return null; }
      return `${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
    } catch (e) { setAiStatus('测试失败：' + ((e && e.message) || e), 'err'); return null; }
  }
  async function clearAi() {
    await chrome.storage.local.remove(LLM_KEY);
    try { await LLM.deleteSecret('apiKey'); } catch (e) { /* ignore */ }
    for (const o of await grantedLlmOrigins()) { try { await chrome.permissions.remove({ origins: [o] }); } catch (e) { /* ignore */ } }
    // the cached answers are a record of watched videos: they go too
    try { const all = await chrome.storage.local.get(null); const ks = Object.keys(all).filter((k) => k.startsWith('a:')); if (ks.length) await chrome.storage.local.remove(ks); } catch (e) { /* ignore */ }
    llmStored = null;
    $('aiKey').value = ''; $('aiModel').value = '';
    aiProviderChanged();
    setAiStatus('已删除 AI 设置、密钥和 AI 分析缓存。');
  }

  async function init() {
    try {
      const v = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
      if (v) $('version').textContent = 'v' + v;
    } catch (e) { /* ignore */ }
    current = await loadSettings();
    applyToForm(current);
    wire();
    updateStorageInfo();
    try {
      await loadAi();
      $('aiProvider').addEventListener('change', aiProviderChanged);
      $('aiSave').addEventListener('click', () => { saveAi().catch((e) => setAiStatus('保存失败：' + ((e && e.message) || e), 'err')); });
      $('aiClear').addEventListener('click', () => { clearAi().catch(() => {}); });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
