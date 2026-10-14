import { assert, assertEquals, assertMatch, assertRejects } from './assert.js';
import { loadApi } from './api-helpers.js';

const BAS = loadApi();
const { md5, getMixinKey, sign } = BAS.wbi;

Deno.test('md5: RFC 1321 vectors', () => {
  assertEquals(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assertEquals(md5('a'), '0cc175b9c0f1b6a831c399e269772661');
  assertEquals(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assertEquals(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assertEquals(md5('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b');
  assertEquals(md5('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), 'd174ab98d277d9f5a5611c2c9f419d9f');
  assertEquals(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890'), '57edf4a22be3c955ac49da2e2107b67a');
  assertEquals(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

Deno.test('md5: UTF-8 aware and padding boundaries (cross-checked with node:crypto when available)', async () => {
  let nodeMd5 = null;
  try {
    const { createHash } = await import('node:crypto');
    nodeMd5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
    assertEquals(nodeMd5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  } catch (_) { nodeMd5 = null; }
  const samples = ['中文', '弹幕 跳伞04:50 🚀', 'ÄÖÜ äöü ß €', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), '哈'.repeat(100), 'bar=514&foo=114&wts=1702204169&zab=1919810ea1db124af3c7062474693fa704f4ff8'];
  for (const s of samples) {
    const h = md5(s);
    assertMatch(h, /^[0-9a-f]{32}$/);
    if (nodeMd5) assertEquals(h, nodeMd5(s), `md5(${JSON.stringify(s.slice(0, 20))})`);
  }
  // known multibyte vector
  assertEquals(md5('中文'), 'a7bac2239fcdcb3a067903d8077c4a07');
  // bytes input matches string input
  assertEquals(md5(new TextEncoder().encode('中文')), md5('中文'));
});

const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';

Deno.test('wbi: mixin key and w_rid match the documented test vector', () => {
  assertEquals(BAS.wbi.MIXIN_KEY_ENC_TAB.length, 64);
  assertEquals(getMixinKey(IMG + SUB), 'ea1db124af3c7062474693fa704f4ff8');
  const q = sign({ foo: '114', bar: '514', zab: 1919810 }, IMG, SUB, { wts: 1702204169 });
  assertEquals(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

Deno.test('wbi.sign: sorted keys, filtered !\'()* characters, encoded values, deterministic for fixed wts', () => {
  const q1 = sign({ z: 1, a: "x!y'z(1)2*3", 'm n': '中 文', skip: undefined, nul: null }, IMG, SUB, { wts: 1700000000 });
  const q2 = sign({ a: "x!y'z(1)2*3", 'm n': '中 文', z: 1 }, IMG, SUB, { wts: 1700000000 });
  assertEquals(q1, q2);
  const parts = q1.split('&');
  const keys = parts.map((p) => decodeURIComponent(p.split('=')[0]));
  assertEquals(keys, ['a', 'm n', 'wts', 'z', 'w_rid']);
  const map = Object.fromEntries(parts.map((p) => p.split('=')));
  assertEquals(map.a, 'xyz123');
  assertEquals(map['m%20n'], encodeURIComponent('中 文'));
  assertMatch(map.w_rid, /^[0-9a-f]{32}$/);
  assertEquals(map.wts, '1700000000');
  // a different wts changes w_rid; default wts is "now"
  assert(sign({ z: 1 }, IMG, SUB, { wts: 1700000001 }) !== sign({ z: 1 }, IMG, SUB, { wts: 1700000000 }));
  const now = Math.round(Date.now() / 1000);
  const wts = Number(/(?:^|&)wts=(\d+)/.exec(sign({ z: 1 }, IMG, SUB))[1]);
  assert(Math.abs(wts - now) <= 2);
});

Deno.test('wbi.keysFromNav / needsRefresh', () => {
  assertEquals(BAS.wbi.keysFromNav({ code: -101, data: { isLogin: false, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png` } } }), { imgKey: IMG, subKey: SUB });
  assertEquals(BAS.wbi.keysFromNav({ code: 0, data: {} }), null);
  assertEquals(BAS.wbi.keysFromNav(null), null);
  assert(BAS.wbi.needsRefresh({ code: -352, message: '风控校验失败' }));
  assert(BAS.wbi.needsRefresh({ code: 0, data: { v_voucher: 'voucher_x' } }));
  assert(!BAS.wbi.needsRefresh({ code: 0, data: { view_points: [] } }));
  assert(!BAS.wbi.needsRefresh(undefined));
});

Deno.test('wbi.getKeys: fetches nav once, memoises, reuses storage cache, force refetches', async () => {
  const orig = BAS.api.fetchJSON;
  let calls = 0;
  BAS.wbi.__reset();
  BAS.storage.__resetMemory();
  BAS.api.fetchJSON = async (url) => {
    calls++;
    assertEquals(url, 'https://api.bilibili.com/x/web-interface/nav');
    return { code: -101, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png` } } };
  };
  try {
    const [k1, k2] = await Promise.all([BAS.wbi.getKeys(), BAS.wbi.getKeys()]);   // concurrent → single request
    assertEquals(k1, { imgKey: IMG, subKey: SUB });
    assertEquals(k2, k1);
    assertEquals(calls, 1);
    assertEquals(await BAS.wbi.getKeys(), k1);
    assertEquals(calls, 1);
    // storage (memory fallback) now holds the keys → a fresh module memo still avoids the network
    BAS.wbi.__reset();
    assertEquals(await BAS.wbi.getKeys(), k1);
    assertEquals(calls, 1);
    assertEquals((await BAS.storage.getWbiKeys()).imgKey, IMG);
    // force
    assertEquals(await BAS.api.getWbiKeys({ force: true }), k1);
    assertEquals(calls, 2);
    // signedUrl
    const url = await BAS.wbi.signedUrl('https://api.bilibili.com/x/player/wbi/v2', { aid: 1, cid: 2 });
    assertMatch(url, /^https:\/\/api\.bilibili\.com\/x\/player\/wbi\/v2\?aid=1&cid=2&wts=\d+&w_rid=[0-9a-f]{32}$/);
    assertEquals(calls, 2);
    // broken nav → rejects with a Chinese message
    BAS.wbi.__reset(); BAS.storage.__resetMemory();
    BAS.api.fetchJSON = async () => ({ code: 0, data: {} });
    await assertRejects(() => BAS.wbi.getKeys(), Error, 'WBI 密钥获取失败');
  } finally {
    BAS.api.fetchJSON = orig;
    BAS.wbi.__reset();
    BAS.storage.__resetMemory();
  }
});
