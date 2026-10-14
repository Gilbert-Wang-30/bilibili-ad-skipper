/* Bilibili Ad Skipper — WBI request signing (w_rid / wts) + pure-JS MD5.
 * No DOM / chrome.* access at load time. Keys come from x/web-interface/nav via BAS.api.fetchJSON and
 * are cached 6 h through BAS.storage (which itself falls back to memory when chrome.storage is absent). */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) throw new Error('[BAS] 00-ns.js must be loaded before 21-wbi.js');

  const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
  const KEYS_TTL_MS = 6 * 60 * 60 * 1000;

  // ---------- MD5 (RFC 1321), UTF-8 aware ----------
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let textEncoder = null;
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      if (!textEncoder) textEncoder = new TextEncoder();
      return textEncoder.encode(str);
    }
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
  function md5Bytes(bytes) {
    const n = bytes.length;
    const nBlocks = ((n + 8) >>> 6) + 1;
    const w = new Int32Array(nBlocks * 16);
    for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << ((i & 3) << 3);
    w[n >> 2] |= 0x80 << ((n & 3) << 3);
    const bitLen = n * 8;
    w[nBlocks * 16 - 2] = bitLen >>> 0;
    w[nBlocks * 16 - 1] = Math.floor(bitLen / 4294967296) | 0;
    let a = 0x67452301, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476;
    for (let off = 0; off < w.length; off += 16) {
      let A = a, B = b, C = c, D = d;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const x = (A + F + K[i] + w[off + g]) | 0;
        const s = S[((i >> 4) << 2) + (i & 3)];
        const tmp = D; D = C; C = B;
        B = (B + ((x << s) | (x >>> (32 - s)))) | 0;
        A = tmp;
      }
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    let hex = '';
    for (const v of [a, b, c, d]) for (let j = 0; j < 4; j++) hex += ((v >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }
  /** md5 of a string (UTF-8 encoded) or raw bytes → 32-char lowercase hex. */
  function md5(input) {
    if (input instanceof Uint8Array) return md5Bytes(input);
    if (input instanceof ArrayBuffer) return md5Bytes(new Uint8Array(input));
    return md5Bytes(utf8Bytes(input == null ? '' : String(input)));
  }

  // ---------- WBI ----------
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];
  /** getMixinKey(imgKey + subKey) → 32-char mixin key. */
  function getMixinKey(orig) {
    const s = String(orig || '');
    let out = '';
    for (const n of MIXIN_KEY_ENC_TAB) out += s[n] || '';
    return out.slice(0, 32);
  }
  const CHR_FILTER = /[!'()*]/g;

  /**
   * Sign params → query string `k=v&…&wts=…&w_rid=…` (keys sorted, values stripped of !'()*).
   * opts.wts overrides the timestamp (tests). Null/undefined values are dropped.
   */
  function sign(params, imgKey, subKey, opts) {
    const mixinKey = getMixinKey(String(imgKey || '') + String(subKey || ''));
    const wts = opts && Number.isFinite(opts.wts) ? Math.floor(opts.wts) : Math.round(Date.now() / 1000);
    const p = Object.assign({}, params || {}, { wts });
    const query = Object.keys(p)
      .filter((k) => p[k] !== undefined && p[k] !== null)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(CHR_FILTER, ''))}`)
      .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
  }

  /** Extract `img_key` / `sub_key` from a nav response (`data.wbi_img.img_url/sub_url`). */
  function keysFromNav(json) {
    const wi = json && json.data && json.data.wbi_img;
    const base = (u) => {
      if (typeof u !== 'string' || !u) return '';
      const file = u.slice(u.lastIndexOf('/') + 1);
      const dot = file.lastIndexOf('.');
      return dot > 0 ? file.slice(0, dot) : file;
    };
    const imgKey = base(wi && wi.img_url), subKey = base(wi && wi.sub_url);
    return imgKey && subKey ? { imgKey, subKey } : null;
  }

  /** True when a JSON reply signals a bad/expired signature (keys should be refreshed). */
  function needsRefresh(json) {
    if (!json || typeof json !== 'object') return false;
    if (json.code === -352 || json.code === -403) return true;
    return !!(json.data && typeof json.data === 'object' && json.data.v_voucher);
  }

  let memo = null;       // {imgKey, subKey, ts}
  let inflight = null;   // Promise<{imgKey, subKey}>

  /**
   * Resolve the current WBI keys: memory → storage (6 h TTL) → nav endpoint. `force` skips caches.
   * @returns {Promise<{imgKey:string, subKey:string}>}
   */
  async function getKeys(opts) {
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (!force && memo && now - memo.ts < KEYS_TTL_MS) return { imgKey: memo.imgKey, subKey: memo.subKey };
    if (inflight) return inflight;
    inflight = (async () => {
      if (!force && BAS.storage && typeof BAS.storage.getWbiKeys === 'function') {
        try {
          const stored = await BAS.storage.getWbiKeys();
          if (stored && stored.imgKey && stored.subKey && now - stored.ts < KEYS_TTL_MS) {
            memo = stored;
            return { imgKey: stored.imgKey, subKey: stored.subKey };
          }
        } catch (e) { BAS.debug('wbi: storage read failed', e); }
      }
      if (!BAS.api || typeof BAS.api.fetchJSON !== 'function') throw new Error('WBI 密钥获取失败：API 层不可用');
      // Shared by concurrent callers, so it must not inherit one caller's AbortSignal (fetchJSON has its own timeout).
      const json = await BAS.api.fetchJSON(NAV_URL);
      const keys = keysFromNav(json);
      if (!keys) throw new Error('WBI 密钥获取失败：nav 响应缺少 wbi_img');
      memo = { imgKey: keys.imgKey, subKey: keys.subKey, ts: Date.now() };
      if (BAS.storage && typeof BAS.storage.setWbiKeys === 'function') {
        try { await BAS.storage.setWbiKeys(memo); } catch (e) { BAS.debug('wbi: storage write failed', e); }
      }
      return keys;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  /** Build a fully signed URL: base + '?' + sign(params). */
  async function signedUrl(base, params, opts) {
    const { imgKey, subKey } = await getKeys(opts);
    return `${base}?${sign(params, imgKey, subKey)}`;
  }

  BAS.wbi = {
    NAV_URL, KEYS_TTL_MS, MIXIN_KEY_ENC_TAB,
    md5, getMixinKey, sign, keysFromNav, needsRefresh, getKeys, signedUrl,
    /** test hook: forget memoised keys */
    __reset() { memo = null; inflight = null; },
  };
})();
