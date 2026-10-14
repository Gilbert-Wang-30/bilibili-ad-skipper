/* Bilibili Ad Skipper — minimal protobuf wire decoder for DmSegMobileReply (danmaku segments).
 * Pure functions, no DOM / chrome.* access. Never throws on truncated or garbage input: parsing
 * stops at the first malformed byte and whatever was decoded so far is returned. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) throw new Error('[BAS] 00-ns.js must be loaded before 20-protobuf.js');

  const MAX_SAFE = Number.MAX_SAFE_INTEGER;
  const TWO_63 = 2 ** 63;
  let textDecoder = null;
  function decodeUtf8(u8, start, end) {
    try {
      if (!textDecoder) textDecoder = new TextDecoder('utf-8', { fatal: false });
      return textDecoder.decode(u8.subarray(start, end));
    } catch (_) {
      // Extremely defensive fallback (TextDecoder missing): latin-1 view.
      let s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
      return s;
    }
  }

  /** Coerce any buffer-ish input to a Uint8Array (or null when unusable). */
  function toU8(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    return null;
  }

  /**
   * Read a base-128 varint at `pos`. Uses Number math (exact below 2^53) and falls back to BigInt
   * only when the value does not fit. Returns [value, nextPos] or null when truncated / overlong.
   */
  function readVarint(u8, pos, end) {
    let result = 0, mul = 1, i = pos;
    for (let n = 0; n < 10; n++) {
      if (i >= end) return null;
      const b = u8[i++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (result > MAX_SAFE) return [readVarintBig(u8, pos, i), i];
        return [result, i];
      }
      mul *= 128;
    }
    return null;
  }
  function readVarintBig(u8, pos, end) {
    let r = 0n, shift = 0n;
    for (let i = pos; i < end; i++) {
      r |= BigInt(u8[i] & 0x7f) << shift;
      shift += 7n;
    }
    return BigInt.asUintN(64, r);
  }
  /** Interpret a decoded varint as a signed 64-bit integer → Number (negative int32/int64 are 10-byte varints). */
  function toInt(v) {
    if (typeof v === 'bigint') return Number(BigInt.asIntN(64, v));
    if (v >= TWO_63) return v - 2 ** 64;  // cannot really happen (BigInt path), kept for completeness
    return v;
  }

  /**
   * Walk the fields of a message in u8[start, end). cb(field, wireType, value, ldStart, ldEnd):
   *   wireType 0 → value = Number|BigInt; 5 → value = uint32; 1 → value = undefined, bytes at [ldStart, ldEnd);
   *   2 → value = undefined, payload at [ldStart, ldEnd). Returning false from cb stops the walk.
   * Returns the position where parsing stopped (end when fully consumed).
   */
  function walk(u8, start, end, cb) {
    let pos = start;
    while (pos < end) {
      const tagStart = pos;
      const tag = readVarint(u8, pos, end);
      if (!tag || typeof tag[0] !== 'number') return tagStart;
      const key = tag[0];
      pos = tag[1];
      const field = Math.floor(key / 8), wt = key % 8;
      if (field === 0) return tagStart;                 // field 0 is invalid → garbage
      switch (wt) {
        case 0: {
          const v = readVarint(u8, pos, end);
          if (!v) return pos;
          pos = v[1];
          if (cb(field, 0, v[0], 0, 0) === false) return pos;
          break;
        }
        case 1: {
          if (pos + 8 > end) return pos;
          if (cb(field, 1, undefined, pos, pos + 8) === false) return pos + 8;
          pos += 8;
          break;
        }
        case 2: {
          const l = readVarint(u8, pos, end);
          if (!l || typeof l[0] !== 'number') return pos;
          const len = l[0];
          pos = l[1];
          if (pos + len > end) return pos;              // truncated payload
          if (cb(field, 2, undefined, pos, pos + len) === false) return pos + len;
          pos += len;
          break;
        }
        case 5: {
          if (pos + 4 > end) return pos;
          const v = (u8[pos] | (u8[pos + 1] << 8) | (u8[pos + 2] << 16) | (u8[pos + 3] << 24)) >>> 0;
          if (cb(field, 5, v, pos, pos + 4) === false) return pos + 4;
          pos += 4;
          break;
        }
        case 3: {                                       // deprecated start-group: skip to matching end-group
          const next = skipGroup(u8, pos, end, field);
          if (next < 0) return tagStart;
          pos = next;
          break;
        }
        default:                                        // 4 (end-group: handled by skipGroup), 6, 7 → stop here
          return tagStart;
      }
    }
    return pos;
  }
  function skipGroup(u8, pos, end, groupField) {
    // walk() consumes the group's inner fields (nested groups recurse through case 3) and stops at the
    // first end-group tag, which it treats as unparseable; consume that tag here if it matches.
    const stop = walk(u8, pos, end, () => true);
    const tag = readVarint(u8, stop, end);
    if (tag && typeof tag[0] === 'number' && tag[0] % 8 === 4 && Math.floor(tag[0] / 8) === groupField) return tag[1];
    return -1;
  }

  /** Generic field list for tests/debugging: [[field, wireType, value], ...]. ld/fixed64 values are Uint8Array views. */
  function decodeFields(input) {
    const u8 = toU8(input);
    const out = [];
    if (!u8) return out;
    try {
      walk(u8, 0, u8.length, (field, wt, value, s, e) => {
        out.push([field, wt, wt === 0 || wt === 5 ? value : u8.subarray(s, e)]);
        return true;
      });
    } catch (e) { BAS.debug('decodeFields aborted', e); }
    return out;
  }

  /**
   * Decode one DanmakuElem (fields: 2 progress ms, 3 mode, 7 content, 9 weight, 10 action, 11 pool, 12 idStr).
   * Unknown fields (1, 4, 5, 6, 8, 13, 15, 18, 20, 21, 22, 24–27 …) are skipped by wire type.
   * @returns {import('./00-ns.js').Danmaku}
   */
  function decodeElem(u8, start, end) {
    let progress = 0, mode = 1, pool = 0, weight = 0;
    let text = '', action = '', idStr = '';
    walk(u8, start, end, (field, wt, value, s, e) => {
      if (wt === 0) {
        if (field === 2) progress = toInt(value);
        else if (field === 3) mode = toInt(value);
        else if (field === 9) weight = toInt(value);
        else if (field === 11) pool = toInt(value);
      } else if (wt === 2) {
        if (field === 7) text = decodeUtf8(u8, s, e);
        else if (field === 10) action = decodeUtf8(u8, s, e);
        else if (field === 12) idStr = decodeUtf8(u8, s, e);
      }
      return true;
    });
    /** @type {{t:number, text:string, action?:string, mode:number, pool:number, weight:number, idStr?:string}} */
    const d = { t: progress > 0 ? progress / 1000 : 0, text, mode, pool, weight };
    if (action) d.action = action;
    if (idStr) d.idStr = idStr;
    return d;
  }

  /**
   * Decode a DmSegMobileReply (`repeated DanmakuElem elems = 1`) into Danmaku[] in wire order.
   * Accepts ArrayBuffer | Uint8Array | DataView | number[]. Never throws.
   * @returns {Array<{t:number, text:string, action?:string, mode:number, pool:number, weight:number, idStr?:string}>}
   */
  function decodeDmSeg(input) {
    const out = [];
    const u8 = toU8(input);
    if (!u8 || !u8.length) return out;
    try {
      walk(u8, 0, u8.length, (field, wt, value, s, e) => {
        if (field === 1 && wt === 2) {
          try { out.push(decodeElem(u8, s, e)); } catch (err) { BAS.debug('bad elem skipped', err); }
        }
        return true;
      });
    } catch (e) { BAS.debug('decodeDmSeg aborted', e); }
    return out;
  }

  BAS.decodeDmSeg = decodeDmSeg;
  BAS.protobuf = { decodeFields, decodeDmSeg, readVarint, walk, toU8 };
})();
