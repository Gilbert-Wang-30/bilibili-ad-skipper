/* Bilibili Ad Skipper — language-model providers for the AI transcript check.
 * Request / response mapping (pure), loaded by the background worker (importScripts), the options page and the tests,
 * plus the key store. The API key lives in this extension's own IndexedDB, which only extension pages and the background
 * worker can open (a content script's IndexedDB is the web page's); chrome.storage.local holds only the non-secret
 * settings, because content scripts can read that area. Content scripts send the prompt and get back the reply text.
 * Two wire formats: Anthropic Messages (Claude) and OpenAI-compatible chat completions (DeepSeek, Qwen, GLM, OpenAI,
 * Gemini, Ollama / any compatible server).
 */
(function (root) {
  'use strict';

  // `tested`: measured on the crowd-labelled transcripts (README "AI transcript check"); the others use the same prompt
  // but their accuracy was not measured here.
  const PROVIDERS = Object.freeze({
    // claude-opus-5-5 by default; claude-haiku-5-5 measured as accurate on the test set at about 1/40 of the price
    anthropic: { label: 'Claude（Anthropic）', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', altModel: 'claude-haiku-5-5', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', tested: true },
    deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyHint: 'sk-…', keyUrl: 'https://platform.deepseek.com/api_keys', extra: () => ({ thinking: { type: 'disabled' } }) },
    qwen: { label: '通义千问（阿里云百炼）', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash', keyHint: 'sk-…', keyUrl: 'https://bailian.console.aliyun.com/', extra: () => ({ enable_thinking: false }) },
    glm: { label: '智谱 GLM（GLM-4.7-Flash 免费）', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', keyHint: '', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', extra: () => ({ thinking: { type: 'disabled' } }) },
    // reasoning models count their thinking against the output cap: keep it minimal and the cap generous
    // reasoning models only (gpt-4.1 / gpt-4o reject reasoning_effort)
    openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys', noTemperature: true, tokenParam: 'max_completion_tokens', maxTokens: 16000, extra: (m) => (/^(gpt-5|o\d)/.test(m) ? { reasoning_effort: 'minimal' } : {}) },
    // new keys get the 3.x models; thinking can be switched off only on 2.5 Flash
    gemini: { label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey', maxTokens: 16000, extra: (m) => (/^gemini-2\.5-flash/.test(m) ? { reasoning_effort: 'none' } : {}) },
    custom: { label: '自定义（OpenAI 兼容接口 / Ollama）', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', keyHint: '可留空', keyUrl: '', keyOptional: true },
  });
  const ANTHROPIC_VERSION = '2026-10-21';
  const MAX_TOKENS = 8000;      // the answer is a few hundred tokens; Claude's adaptive thinking needs room as well
  const MAX_PROMPT_CHARS = 200000;

  /** Stored config → normalized config, or null when it is not usable. */
  function normalizeConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const p = PROVIDERS[raw.provider];
    if (!p) return null;
    const baseUrl = String(raw.baseUrl || p.baseUrl || '').trim().replace(/\/+$/, '');
    let u;
    try { u = new URL(baseUrl); } catch (e) { return null; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';      // the hosts the manifest can grant over http
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;    // keys only over https (or to this machine)
    const model = String(raw.model || p.model || '').trim().slice(0, 120);
    const apiKey = String(raw.apiKey || '').trim();
    if (!model || (!apiKey && !p.keyOptional)) return null;
    return { provider: raw.provider, kind: p.kind, baseUrl, model, apiKey, origin: u.origin, label: p.label, tested: !!p.tested };
  }

  /** Host permission pattern needed for a config. */
  function originPattern(cfg) { return cfg.origin + '/*'; }

  /**
   * @param {object} cfg normalizeConfig() result
   * @param {{system:string, user:string, schema?:object}} req
   * @returns {{url:string, init:RequestInit}}
   */
  function buildHttp(cfg, req) {
    const system = String(req.system || ''), user = String(req.user || '').slice(0, MAX_PROMPT_CHARS);
    if (cfg.kind === 'anthropic') {
      const body = {
        model: cfg.model, max_tokens: MAX_TOKENS, system,
        messages: [{ role: 'user', content: user }],
        // a classification over a transcript: low effort keeps it fast and cheap
        output_config: Object.assign(supportsEffort(cfg.model) ? { effort: 'low' } : {}, req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
      };
      const headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
      // a classifier decline is re-run server-side on the model Anthropic recommends for it (Haiku has no fallback)
      if (hasServerFallback(cfg.model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
      return { url: cfg.baseUrl + '/v1/messages', init: { method: 'POST', credentials: 'omit', cache: 'no-store', headers, body: JSON.stringify(body) } };
    }
    const p = PROVIDERS[cfg.provider] || {};
    const body = Object.assign({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }, typeof p.extra === 'function' ? p.extra(cfg.model) : {});
    body[p.tokenParam || 'max_tokens'] = p.maxTokens || 8192;
    if (!p.noTemperature) body.temperature = 0;
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
    return { url: cfg.baseUrl + '/chat/completions', init: { method: 'POST', credentials: 'omit', cache: 'no-store', headers, body: JSON.stringify(body) } };
  }

  /**
   * HTTP status + parsed JSON → {ok, text} or {ok:false, error, retry}.
   * @returns {{ok:boolean, text?:string, error?:string, retry?:boolean, usage?:object}}
   */
  function parseHttp(cfg, status, json) {
    const retry = status === 429 || status >= 500;
    const ej = Array.isArray(json) ? json[0] : json;          // Gemini's OpenAI-compatible errors come as an array
    const apiErr = ej && (ej.error && (ej.error.message || ej.error.status || ej.error.type || ej.error.code)) || (ej && ej.message);
    if (status === 403 && !cfg.apiKey) return { ok: false, error: '服务器拒绝了扩展的请求（本机 Ollama 需设置环境变量 OLLAMA_ORIGINS=chrome-extension://* 后重启）', retry: false };
    if (status === 401 || status === 403) return { ok: false, error: 'API 密钥无效或没有权限' + (apiErr ? '：' + String(apiErr).slice(0, 160) : ''), retry: false };
    if (!(status >= 200 && status < 300)) return { ok: false, error: `模型服务返回 HTTP ${status}` + (apiErr ? '：' + String(apiErr).slice(0, 200) : ''), retry };
    if (!json || typeof json !== 'object') return { ok: false, error: '模型服务的回复不是 JSON', retry: true };
    if (cfg.kind === 'anthropic') {
      if (json.type === 'error') return { ok: false, error: String(apiErr || '模型服务出错').slice(0, 200), retry };
      if (json.stop_reason === 'refusal') return { ok: false, error: '模型拒绝分析这段字幕', retry: false };
      const text = (Array.isArray(json.content) ? json.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      if (json.stop_reason === 'max_tokens') return { ok: false, error: '模型回复被截断', retry: false };
      if (!text) return { ok: false, error: '模型没有给出回复', retry: false };
      return { ok: true, text, usage: json.usage || null };
    }
    const c = json.choices && json.choices[0];
    const text = c && c.message && typeof c.message.content === 'string' ? c.message.content : '';
    // a reply cut at the token cap would be cut the same way again: not retried
    if (c && c.finish_reason === 'length') return { ok: false, error: '模型回复被截断（输出长度上限）', retry: false };
    if (!text) return { ok: false, error: String(apiErr || '模型没有给出回复').slice(0, 200), retry: false };
    return { ok: true, text, usage: json.usage || null };
  }

  /** Server-side refusal fallbacks (`fallbacks: "default"`): Claude Opus 5 / 5.5, Fable 5.1, Sonnet 5.5. */
  function hasServerFallback(model) { return /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(String(model)); }
  /** Effort is sent only to Claude models known to accept it (Haiku 4.5 and Sonnet 4.5 reject it; unknown ids get none). */
  function supportsEffort(model) { return /^claude-(haiku-5|sonnet-(4-[6-9]|5)|opus-(4-[5-9]|5)|fable|mythos)/.test(String(model)); }

  // ---------- key store: IndexedDB of the extension origin ----------
  const DB_NAME = 'bas-secrets', DB_STORE = 'kv';
  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore(DB_STORE); } catch (e) { /* exists */ } };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbOp(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    } finally { db.close(); }
  }
  const getSecret = (k) => dbOp('readonly', (st) => st.get(k)).then((v) => (v == null ? null : v));
  const setSecret = (k, v) => dbOp('readwrite', (st) => st.put(v, k));
  const deleteSecret = (k) => dbOp('readwrite', (st) => st.delete(k));

  const api = { PROVIDERS, ANTHROPIC_VERSION, MAX_PROMPT_CHARS, normalizeConfig, originPattern, buildHttp, parseHttp, supportsEffort, hasServerFallback, getSecret, setSecret, deleteSecret };
  root.BAS_LLM_PROVIDERS = api;
})(typeof self !== 'undefined' ? self : globalThis);
