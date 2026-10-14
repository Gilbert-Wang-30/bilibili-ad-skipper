// Helper for API-layer tests: makes sure 10-storage / 20-protobuf / 21-wbi / 22-api are evaluated even
// when another test file already called loadBAS() with a different module list, or when other agents'
// modules are still missing.
import { loadBAS } from './load.js';

const SRC = new URL('../src/content/', import.meta.url);
const MINE = ['00-ns.js', '10-storage.js', '20-protobuf.js', '21-wbi.js', '22-api.js'];
const NEEDS = { '10-storage.js': 'storage', '20-protobuf.js': 'decodeDmSeg', '21-wbi.js': 'wbi', '22-api.js': 'api' };

export function loadApi() {
  let BAS;
  try { BAS = loadBAS(); } catch (_) { BAS = loadBAS(MINE); }
  for (const [file, prop] of Object.entries(NEEDS)) {
    if (!BAS[prop]) new Function(Deno.readTextFileSync(new URL(file, SRC)))();
  }
  return globalThis.BAS;
}

/** Minimal protobuf encoder (varint + length-delimited + fixed) used to build synthetic DmSegMobileReply buffers. */
export const pb = {
  varint(n) {
    let v = BigInt(n);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const out = [];
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  },
  tag(field, wt) { return pb.varint(field * 8 + wt); },
  v(field, n) { return [...pb.tag(field, 0), ...pb.varint(n)]; },
  bytes(field, arr) { return [...pb.tag(field, 2), ...pb.varint(arr.length), ...arr]; },
  s(field, str) { return pb.bytes(field, [...new TextEncoder().encode(str)]); },
  f64(field, eight) { return [...pb.tag(field, 1), ...eight]; },
  f32(field, four) { return [...pb.tag(field, 5), ...four]; },
  msg(field, parts) { return pb.bytes(field, parts.flat()); },
  u8(parts) { return Uint8Array.from(parts.flat()); },
};

/** In-memory fake of chrome.storage.{sync,local} + onChanged (async callbacks like the real thing). */
export function makeFakeChrome() {
  const listeners = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const emit = (changes, area) => { if (Object.keys(changes).length) for (const fn of listeners) setTimeout(() => fn(changes, area), 0); };
  const finish = (value, cb) => { if (typeof cb === 'function') { setTimeout(() => cb(value), 0); return undefined; } return Promise.resolve(value); };
  const mkArea = (name) => {
    const data = new Map();
    return {
      _data: data,
      get(keys, cb) {
        const out = {};
        if (keys == null) for (const [k, v] of data) out[k] = clone(v);
        else if (typeof keys === 'string') { if (data.has(keys)) out[keys] = clone(data.get(keys)); }
        else if (Array.isArray(keys)) { for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k)); }
        else for (const k of Object.keys(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(keys[k]);
        return finish(out, cb);
      },
      set(obj, cb) {
        const changes = {};
        for (const k of Object.keys(obj)) { changes[k] = { oldValue: clone(data.get(k)), newValue: clone(obj[k]) }; data.set(k, clone(obj[k])); }
        emit(changes, name);
        return finish(undefined, cb);
      },
      remove(keys, cb) {
        const list = typeof keys === 'string' ? [keys] : keys;
        const changes = {};
        for (const k of list) if (data.has(k)) { changes[k] = { oldValue: clone(data.get(k)) }; data.delete(k); }
        emit(changes, name);
        return finish(undefined, cb);
      },
      clear(cb) { const changes = {}; for (const [k, v] of data) changes[k] = { oldValue: clone(v) }; data.clear(); emit(changes, name); return finish(undefined, cb); },
    };
  };
  return {
    runtime: { lastError: undefined, id: 'fake-extension-id' },
    storage: {
      sync: mkArea('sync'), local: mkArea('local'),
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, hasListener(fn) { return listeners.has(fn); } },
    },
  };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
