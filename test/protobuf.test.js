import { assert, assertEquals, assertStrictEquals } from './assert.js';
import { loadApi, pb } from './api-helpers.js';

const BAS = loadApi();

// ---- synthetic DmSegMobileReply ----
const BIG_ID = 1727893838460190208n;   // real-world dmid magnitude (> 2^53)
function elem1() { // progress omitted (=0), nothing exotic
  return pb.msg(1, [pb.v(1, 1), pb.v(3, 1), pb.v(4, 25), pb.v(5, 16777215), pb.s(6, 'abcd1234'), pb.s(7, '空降'), pb.v(8, 1700000000), pb.v(9, 10), pb.s(12, '1'), pb.v(13, 0)]);
}
function elem2() { // airborne action, big id
  return pb.msg(1, [pb.v(1, BIG_ID), pb.v(2, 254000), pb.v(3, 1), pb.v(4, 25), pb.v(5, 16777215), pb.s(6, 'ffee0011'), pb.s(7, '跳伞04:50'), pb.v(8, 1700000001), pb.v(9, 5), pb.s(10, 'airborne:290000'), pb.s(12, String(BIG_ID)), pb.v(13, 1048576)]);
}
function elem3() { // unknown fields 15/20/21/24/25/26/27 + unknown fixed64/fixed32 interleaved, negative int32 attr, pool 1
  return pb.msg(1, [
    pb.v(15, 3), pb.v(1, 42), pb.v(2, 359500), pb.s(20, '0'), pb.v(3, 5), pb.s(7, '欢迎回来'), pb.v(24, 60001), pb.s(21, '0'),
    pb.v(25, 1), pb.v(26, 1176840), pb.v(27, 1), pb.f64(30, [1, 2, 3, 4, 5, 6, 7, 8]), pb.v(9, 7), pb.f32(31, [9, 9, 9, 9]), pb.v(11, 1), pb.v(13, -1), pb.s(12, '42'),
  ]);
}
function buildReply() {
  return pb.u8([elem1(), pb.v(2, 0), elem2(), pb.msg(5, [pb.v(1, 60001), pb.s(2, 'https://example/colorful.png')]), elem3()]);
}

Deno.test('decodeDmSeg decodes a synthetic 3-elem reply (defaults, action, unknown fields skipped)', () => {
  const buf = buildReply();
  const list = BAS.decodeDmSeg(buf.buffer);     // ArrayBuffer input
  assertEquals(list.length, 3);
  const [a, b, c] = list;
  assertEquals(a.t, 0);
  assertEquals(a.text, '空降');
  assertStrictEquals(a.action, undefined);
  assertEquals(a.mode, 1); assertEquals(a.pool, 0); assertEquals(a.weight, 10); assertEquals(a.idStr, '1');

  assertEquals(b.t, 254);
  assertEquals(b.text, '跳伞04:50');
  assertEquals(b.action, 'airborne:290000');
  assertEquals(b.weight, 5);
  assertEquals(b.idStr, String(BIG_ID));

  assertEquals(c.t, 359.5);
  assertEquals(c.text, '欢迎回来');
  assertEquals(c.mode, 5); assertEquals(c.pool, 1); assertEquals(c.weight, 7); assertEquals(c.idStr, '42');
  assertStrictEquals(c.action, undefined);

  // Uint8Array and DataView inputs give identical results
  assertEquals(BAS.decodeDmSeg(buf), list);
  assertEquals(BAS.decodeDmSeg(new DataView(buf.buffer)), list);
});

Deno.test('protobuf.decodeFields: generic field list, BigInt only above 2^53, negative int32 handled', () => {
  const top = BAS.protobuf.decodeFields(buildReply());
  assertEquals(top.map((f) => [f[0], f[1]]), [[1, 2], [2, 0], [1, 2], [5, 2], [1, 2]]);
  const fields2 = BAS.protobuf.decodeFields(top[2][2]);
  const id = fields2.find((f) => f[0] === 1)[2];
  assertStrictEquals(typeof id, 'bigint');
  assertEquals(id, BIG_ID);
  const progress = fields2.find((f) => f[0] === 2)[2];
  assertStrictEquals(typeof progress, 'number');
  assertEquals(progress, 254000);
  const fields3 = BAS.protobuf.decodeFields(top[4][2]);
  const attr = fields3.find((f) => f[0] === 13)[2];
  assertStrictEquals(typeof attr, 'bigint');                       // 10-byte sign-extended varint
  assertEquals(Number(BigInt.asIntN(64, attr)), -1);
  const f64 = fields3.find((f) => f[0] === 30);
  assertEquals(f64[1], 1); assertEquals([...f64[2]], [1, 2, 3, 4, 5, 6, 7, 8]);
  const f32 = fields3.find((f) => f[0] === 31);
  assertEquals(f32[1], 5); assertEquals(f32[2], 0x09090909);
  assertEquals(fields3.find((f) => f[0] === 20)[2], Uint8Array.from([0x30]));
});

Deno.test('decodeDmSeg never throws on truncated input and returns what was parsed', () => {
  const buf = buildReply();
  let maxLen = 0;
  for (let cut = 0; cut <= buf.length; cut++) {
    const list = BAS.decodeDmSeg(buf.subarray(0, cut));
    assert(Array.isArray(list));
    assert(list.length <= 3);
    assert(list.length >= maxLen, 'parsed count must be monotonic in the prefix length');
    maxLen = list.length;
    for (const d of list) {
      assertStrictEquals(typeof d.t, 'number');
      assertStrictEquals(typeof d.text, 'string');
      assert(d.t >= 0);
    }
  }
  assertEquals(maxLen, 3);
  // The first elem is complete after its own bytes → already decodable
  assertEquals(BAS.decodeDmSeg(buf.subarray(0, elem1().length)).length, 1);
});

Deno.test('decodeDmSeg never throws on garbage input', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 0xff; };
  for (let round = 0; round < 50; round++) {
    const n = 1 + (rnd() * 8);
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = rnd();
    assert(Array.isArray(BAS.decodeDmSeg(g)));
    assert(Array.isArray(BAS.protobuf.decodeFields(g)));
  }
  assert(Array.isArray(BAS.decodeDmSeg(new Uint8Array(200).fill(0xff))));
  assert(Array.isArray(BAS.decodeDmSeg(new Uint8Array(200).fill(0x00))));
  // length-delimited header claiming more bytes than exist
  assertEquals(BAS.decodeDmSeg(Uint8Array.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3])), []);
  // nonsense inputs
  assertEquals(BAS.decodeDmSeg(null), []);
  assertEquals(BAS.decodeDmSeg(undefined), []);
  assertEquals(BAS.decodeDmSeg('string'), []);
  assertEquals(BAS.decodeDmSeg(new ArrayBuffer(0)), []);
  // an element with a broken inner field still yields the fields parsed before the break
  const broken = pb.u8([pb.bytes(1, [...pb.v(2, 1000), ...pb.s(7, 'ok'), 0x52, 0x7f, 0x01])]);   // field 10 ld with len 127 but 1 byte
  const l = BAS.decodeDmSeg(broken);
  assertEquals(l.length, 1); assertEquals(l[0].t, 1); assertEquals(l[0].text, 'ok');
});

Deno.test('protobuf: deprecated (nested) groups are skipped, stray end-group stops parsing', () => {
  // field1{ field2=5, field3{ field4=1 } } field5=7
  const g = Uint8Array.from([0x0b, 0x10, 0x05, 0x1b, 0x20, 0x01, 0x1c, 0x0c, 0x28, 0x07]);
  assertEquals(BAS.protobuf.decodeFields(g), [[5, 0, 7]]);
  // group inside an elem does not disturb the elem's own fields
  const el = pb.u8([pb.msg(1, [pb.v(2, 1500), [0x1b, 0x20, 0x01, 0x1c], pb.s(7, '群组后')])]);
  assertEquals(BAS.decodeDmSeg(el).map((d) => [d.t, d.text]), [[1.5, '群组后']]);
  // unterminated group → stop without throwing
  assertEquals(BAS.protobuf.decodeFields(Uint8Array.from([0x0b, 0x10, 0x05])), []);
  // stray end-group → stop
  assertEquals(BAS.protobuf.decodeFields(Uint8Array.from([0x10, 0x05, 0x0c, 0x28, 0x07])), [[2, 0, 5]]);
});

Deno.test('readVarint: Number fast path and BigInt fallback', () => {
  const rv = BAS.protobuf.readVarint;
  const check = (n) => { const b = Uint8Array.from(pb.varint(n)); const r = rv(b, 0, b.length); return r && r[0]; };
  assertEquals(check(0), 0);
  assertEquals(check(127), 127);
  assertEquals(check(128), 128);
  assertEquals(check(300), 300);
  assertEquals(check(2 ** 31), 2 ** 31);
  assertEquals(check(2 ** 32 + 5), 2 ** 32 + 5);
  assertEquals(check(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assertStrictEquals(typeof check(Number.MAX_SAFE_INTEGER), 'number');
  assertEquals(check(2n ** 53n), 2n ** 53n);
  assertStrictEquals(typeof check(2n ** 53n), 'bigint');
  assertEquals(check(2n ** 64n - 1n), 2n ** 64n - 1n);
  assertEquals(rv(Uint8Array.from([0x80, 0x80]), 0, 2), null);             // truncated
  assertEquals(rv(new Uint8Array(11).fill(0x80), 0, 11), null);           // overlong
});

Deno.test('decodeDmSeg handles a large segment quickly (6000 elems)', () => {
  const parts = [];
  for (let i = 0; i < 6000; i++) {
    parts.push(pb.msg(1, [pb.v(1, BIG_ID + BigInt(i)), pb.v(2, (i * 60) % 360000), pb.v(3, 1), pb.v(4, 25), pb.v(5, 16777215), pb.s(6, 'deadbeef'), pb.s(7, `弹幕 ${i} 哈哈哈`), pb.v(8, 1700000000 + i), pb.v(9, i % 11), pb.s(12, String(BIG_ID + BigInt(i))), pb.v(13, 1048576), pb.v(15, i % 24), pb.s(20, '0'), pb.s(21, '0'), pb.v(25, 1), pb.v(26, 1176840), pb.v(27, 1)]));
  }
  const buf = pb.u8(parts);
  const t0 = performance.now();
  const list = BAS.decodeDmSeg(buf);
  const dt = performance.now() - t0;
  assertEquals(list.length, 6000);
  assertEquals(list[1234].text, '弹幕 1234 哈哈哈');
  assertEquals(list[1234].t, ((1234 * 60) % 360000) / 1000);
  assert(dt < 2000, `decoding took ${dt} ms`);
});

Deno.test('decodeDmSeg on real fixture seg_sample.bin (when present)', () => {
  let bytes;
  try { bytes = Deno.readFileSync(new URL('./fixtures/seg_sample.bin', import.meta.url)); }
  catch (_) { console.log('  (seg_sample.bin not present, skipped)'); return; }
  const list = BAS.decodeDmSeg(bytes);
  assert(list.length > 50, `expected > 50 elems, got ${list.length}`);
  const ts = list.map((d) => d.t);
  assert(ts.every((t) => t >= 0 && t <= 360), 'all t within [0,360]');
  let inversions = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) inversions++;
  assert(inversions / ts.length < 0.5, `t should be monotonic-ish (inversions ${inversions}/${ts.length})`);
  assert(list.every((d) => typeof d.text === 'string'));
});
