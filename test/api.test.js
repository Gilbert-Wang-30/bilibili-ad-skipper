import { assert, assertEquals, assertRejects } from './assert.js';
import { loadApi, pb } from './api-helpers.js';

const BAS = loadApi();
const A = BAS.api;

const enc = (s) => [...new TextEncoder().encode(s)];
const segBytes = (items) => pb.u8(items.map(([ms, text], i) => pb.msg(1, [pb.v(1, i + 1), ...(ms ? pb.v(2, ms) : []), pb.v(3, 1), pb.s(7, text), pb.v(9, 5)])));
function res(status, body, type) {
  const ok = status >= 200 && status < 300;
  return {
    ok, status,
    json: async () => { if (type === 'bad') throw new SyntaxError('bad json'); return body; },
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
  };
}
/** Install a fetch stub: handler(url, init) → Response-like | throws. Returns a restore function + call log. */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (init && init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    assertEquals(init.credentials, 'include');
    return handler(String(url), init, calls.length);
  };
  return { calls, restore() { globalThis.fetch = orig; } };
}
function stubChrome(onMessage) {
  const prev = globalThis.chrome;
  const msgs = [];
  globalThis.chrome = { runtime: { id: 'fake', lastError: undefined, sendMessage: async (m) => { msgs.push(m); return onMessage(m); } } };
  return { msgs, restore() { if (prev === undefined) delete globalThis.chrome; else globalThis.chrome = prev; } };
}
const u = (s) => new URL(s);
const qs = (s) => Object.fromEntries(u(s).searchParams.entries());

Deno.test('api.buildUrl / segmentUrl', () => {
  assertEquals(A.buildUrl('/x/player/v2', { aid: 1, cid: 2, skip: undefined, empty: '' }), 'https://api.bilibili.com/x/player/v2?aid=1&cid=2');
  assertEquals(A.segmentUrl(810872, 1176840, 3), 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=1176840&pid=810872&segment_index=3');
  assertEquals(A.segmentUrl(undefined, 5, 1), 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=5&segment_index=1');
  assertEquals(new Uint8Array(A.b64ToBuffer(btoa('\x01\x02\xff'))), Uint8Array.from([1, 2, 255]));
});

Deno.test('api.fetchJSON: direct fetch, no proxy without chrome', async () => {
  const f = stubFetch((url) => (url.includes('ok') ? res(200, { code: 0, data: { x: 1 } }) : res(500, null)));
  try {
    assertEquals(await A.fetchJSON('https://api.bilibili.com/ok'), { code: 0, data: { x: 1 } });
    const err = await assertRejects(() => A.fetchJSON('https://api.bilibili.com/fail'), A.ApiError, 'HTTP 500');
    assertEquals(err.status, 500);
    assertEquals(A.canProxy(), false);
  } finally { f.restore(); }
});

Deno.test('api.fetchJSON/fetchBuffer: falls back to BAS_FETCH proxy on throw / 412 / non-ok; b64 decoded; 304 → empty buffer', async () => {
  const bytes = segBytes([[1000, 'a'], [2000, 'b']]);
  const c = stubChrome((m) => {
    assertEquals(m.type, 'BAS_FETCH');
    if (m.url.includes('throws')) return { ok: true, status: 200, json: { code: 0, via: 'proxy' } };
    if (m.url.includes('412')) return { ok: true, status: 200, json: { code: 0, via: 'proxy412' } };
    if (m.url.includes('500')) return { ok: true, status: 200, json: { code: 0, via: 'proxy500' } };
    if (m.url.includes('bin')) return { ok: true, status: 200, b64: btoa(String.fromCharCode(...bytes)) };
    if (m.url.includes('304')) return { ok: false, status: 304 };
    if (m.url.includes('bothfail')) return { ok: false, status: 503, error: 'down' };
    return { ok: false, status: 404 };
  });
  const f = stubFetch((url) => {
    if (url.includes('throws')) throw new TypeError('Failed to fetch');
    if (url.includes('412')) return res(412, null);
    if (url.includes('500')) return res(500, null);
    if (url.includes('bin')) throw new TypeError('Failed to fetch');
    if (url.includes('304')) return res(304, null);
    if (url.includes('badjson')) return res(200, null, 'bad');
    if (url.includes('bothfail')) return res(500, null);
    return res(200, { code: 0, via: 'direct' });
  });
  try {
    assertEquals(A.canProxy(), true);
    assertEquals((await A.fetchJSON('https://api.bilibili.com/throws')).via, 'proxy');
    assertEquals((await A.fetchJSON('https://api.bilibili.com/412')).via, 'proxy412');
    assertEquals((await A.fetchJSON('https://api.bilibili.com/500')).via, 'proxy500');
    assertEquals((await A.fetchJSON('https://api.bilibili.com/direct')).via, 'direct');
    const buf = await A.fetchBuffer('https://api.bilibili.com/bin');
    assert(buf instanceof ArrayBuffer);
    assertEquals(BAS.decodeDmSeg(buf).map((d) => d.text), ['a', 'b']);
    assertEquals((await A.fetchBuffer('https://api.bilibili.com/304')).byteLength, 0);
    assertEquals(c.msgs.filter((m) => m.url.includes('304')).length, 0, '304 must not hit the proxy');
    // a 200 with a non-JSON body is definitive → no proxy
    await assertRejects(() => A.fetchJSON('https://api.bilibili.com/badjson'), A.ApiError, 'JSON');
    assertEquals(c.msgs.filter((m) => m.url.includes('badjson')).length, 0);
    // both fail → error mentions both
    const err = await assertRejects(() => A.fetchJSON('https://api.bilibili.com/bothfail'), A.ApiError, 'HTTP 500');
    assert(err.message.includes('503'));
    assertEquals(err.status, 503);
  } finally { f.restore(); c.restore(); }
});

Deno.test('api.fetchJSON: abort signal', async () => {
  const f = stubFetch(() => new Promise(() => {}));   // never resolves; stub throws AbortError when pre-aborted
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    const e = await assertRejects(() => A.fetchJSON('https://api.bilibili.com/x', { signal: ctrl.signal }));
    assertEquals(e.name, 'AbortError');
  } finally { f.restore(); }
  // timeout → ApiError 请求超时 (fetch honours the combined signal)
  const f2 = stubFetch((_url, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); })));
  try {
    await assertRejects(() => A.fetchJSON('https://api.bilibili.com/x', { timeoutMs: 20 }), A.ApiError, '请求超时');
  } finally { f2.restore(); }
});

Deno.test('api.getView: normalises data; retries signed wbi/view on risk control; throws on code != 0', async () => {
  BAS.wbi.__reset(); BAS.storage.__resetMemory();
  const view = { aid: 810872, bvid: 'BV1Js411o76u', cid: 1176840, duration: 437, title: '标题', owner: { mid: 1, name: 'up' }, pages: [{ cid: 1176840, page: 1, part: 'P1', duration: 437 }, { cid: 2, page: 2, part: 'P2', duration: 10 }] };
  let plainCode = 0;
  const f = stubFetch((url) => {
    if (url.includes('/x/web-interface/nav')) return res(200, { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    if (url.includes('/x/web-interface/wbi/view')) { assert(/w_rid=[0-9a-f]{32}/.test(url)); return res(200, { code: 0, data: view }); }
    if (url.includes('/x/web-interface/view')) return plainCode === 412 ? res(412, null) : res(200, plainCode === 0 ? { code: 0, data: view } : { code: plainCode, message: 'msg' });
    throw new Error('unexpected ' + url);
  });
  try {
    const v = await A.getView({ bvid: 'BV1Js411o76u' });
    assertEquals(v, { aid: 810872, bvid: 'BV1Js411o76u', cid: 1176840, duration: 437, title: '标题', owner: { mid: 1, name: 'up' }, pages: [{ cid: 1176840, part: 'P1', duration: 437, page: 1 }, { cid: 2, part: 'P2', duration: 10, page: 2 }] });
    assertEquals(qs(f.calls[0]).bvid, 'BV1Js411o76u');
    assertEquals(f.calls.length, 1);
    // 412 → signed retry
    plainCode = 412; f.calls.length = 0;
    assertEquals((await A.getView({ aid: 810872 })).aid, 810872);
    assert(f.calls.some((c) => c.includes('/x/web-interface/wbi/view') && c.includes('aid=810872')));
    // -352 → signed retry
    plainCode = -352; f.calls.length = 0;
    assertEquals((await A.getView({ aid: 810872 })).cid, 1176840);
    assert(f.calls.some((c) => c.includes('/wbi/view')));
    // -404 → definitive, no retry, Chinese error
    plainCode = -404; f.calls.length = 0;
    const e = await assertRejects(() => A.getView({ bvid: 'BV1xx' }), A.ApiError, '视频信息获取失败');
    assertEquals(e.code, -404);
    assertEquals(f.calls.length, 1);
    await assertRejects(() => A.getView({}), TypeError);
  } finally { f.restore(); BAS.wbi.__reset(); BAS.storage.__resetMemory(); }
});

Deno.test('api.getPlayerInfo: unsigned wbi/v2 → signed → legacy v2', async () => {
  BAS.wbi.__reset(); BAS.storage.__resetMemory();
  const vp = [{ type: 2, from: 0, to: 213, content: '开场', imgUrl: 'x', logoUrl: '' }, { type: 2, from: 213, to: 300, content: '广告' }, { bogus: true }];
  let mode = 'unsigned';
  const f = stubFetch((url) => {
    if (url.includes('/nav')) return res(200, { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    if (url.includes('/x/player/wbi/v2')) {
      const signed = url.includes('w_rid=');
      if (mode === 'unsigned' || (mode === 'signed' && signed)) return res(200, { code: 0, data: { aid: 1, cid: 2, view_points: vp } });
      if (mode === 'legacy' && signed) throw new TypeError('network');
      return res(200, { code: -352, message: '风控校验失败', data: { v_voucher: 'voucher_x' } });
    }
    if (url.includes('/x/player/v2')) return mode === 'legacy' ? res(200, { code: 0, data: { aid: 1, cid: 2, view_points: [] } }) : res(200, { code: -400 });
    throw new Error('unexpected ' + url);
  });
  try {
    let r = await A.getPlayerInfo(1, 2);
    assertEquals(r.view_points.map((v) => [v.type, v.from, v.to, v.content]), [[2, 0, 213, '开场'], [2, 213, 300, '广告']]);
    assertEquals(r.aid, 1); assertEquals(r.cid, 2);
    assertEquals(f.calls.length, 1);
    mode = 'signed'; f.calls.length = 0;
    r = await A.getPlayerInfo(1, 2);
    assertEquals(r.view_points.length, 2);
    assert(f.calls.some((c) => c.includes('w_rid=')));
    mode = 'legacy'; f.calls.length = 0;
    r = await A.getPlayerInfo(1, 2);
    assertEquals(r.view_points, []);
    assert(f.calls[f.calls.length - 1].includes('/x/player/v2?'));
    mode = 'none';
    await assertRejects(() => A.getPlayerInfo(1, 2), A.ApiError, '播放器信息获取失败');
  } finally { f.restore(); BAS.wbi.__reset(); BAS.storage.__resetMemory(); }
});

Deno.test('api.getDanmaku: segments 1..N, concurrency ≤ 3, preloaded skip, retry once, missingSegments, sorted', async () => {
  const duration = 1500;                      // → 5 segments
  const seg = (i) => segBytes([[(i - 1) * 360000 + 5000, `s${i}-a`], [(i - 1) * 360000 + 1000, `s${i}-b`]]);
  let inflight = 0, maxInflight = 0;
  const attempts = {};
  const f = stubFetch(async (url) => {
    const i = Number(qs(url).segment_index);
    assertEquals(qs(url).oid, '1176840'); assertEquals(qs(url).pid, '810872'); assertEquals(qs(url).type, '1');
    attempts[i] = (attempts[i] || 0) + 1;
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    if (i === 2 && attempts[i] === 1) throw new TypeError('flaky');      // succeeds on retry
    if (i === 4) throw new TypeError('dead');                            // fails twice → missing
    return res(200, seg(i));
  });
  const got = [];
  try {
    const preloaded = new Map([[3, [{ t: 730, text: 'pre' }]]]);
    const list = await A.getDanmaku(810872, 1176840, duration, { preloaded, onSegment: (i, l, info) => got.push([i, l.length, info.preloaded]) });
    assertEquals(list.segmentCount, 5);
    assertEquals(list.missingSegments, [4]);
    assertEquals(attempts[1], 1); assertEquals(attempts[2], 2); assertEquals(attempts[3], undefined); assertEquals(attempts[4], 2); assertEquals(attempts[5], 1);
    assert(maxInflight <= 3, `max inflight ${maxInflight}`);
    assertEquals(list.map((d) => d.text), ['s1-b', 's1-a', 's2-b', 's2-a', 'pre', 's5-b', 's5-a']);
    for (let i = 1; i < list.length; i++) assert(list[i - 1].t <= list[i].t);
    got.sort((a, b) => a[0] - b[0]);
    assertEquals(got, [[1, 2, false], [2, 2, false], [3, 1, true], [5, 2, false]]);
  } finally { f.restore(); }
});

Deno.test('api.getDanmaku: unknown duration probes until 304/empty; abort propagates', async () => {
  const f = stubFetch(async (url) => {
    const i = Number(qs(url).segment_index);
    return i <= 2 ? res(200, segBytes([[i * 1000, `s${i}`]])) : res(304, null);
  });
  try {
    const list = await A.getDanmaku(1, 2, NaN);
    assertEquals(list.map((d) => d.text), ['s1', 's2']);
    assertEquals(list.missingSegments, []);
    assertEquals(list.segmentCount, 2);
    assert(f.calls.length <= 6, `probing should stop early (made ${f.calls.length} requests)`);
    // a known duration with an empty middle segment keeps going
    f.calls.length = 0;
    const f2 = stubFetch(async (url) => { const i = Number(qs(url).segment_index); return i === 1 ? res(200, new Uint8Array(0)) : res(200, segBytes([[1, 's' + i]])); });
    try {
      const l2 = await A.getDanmaku(1, 2, 720);
      assertEquals(l2.map((d) => d.text), ['s2']);
      assertEquals(l2.missingSegments, []);
    } finally { f2.restore(); }
  } finally { f.restore(); }
  const ctrl = new AbortController();
  const f3 = stubFetch(async () => { ctrl.abort(); return res(200, segBytes([[1, 'x']])); });
  try {
    const e = await assertRejects(() => A.getDanmaku(1, 2, 3600, { signal: ctrl.signal }));
    assertEquals(e.name, 'AbortError');
  } finally { f3.restore(); }
});
