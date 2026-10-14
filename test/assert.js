// Tiny dependency-free assertion helpers (no network import needed).
export class AssertionError extends Error { constructor(msg) { super(msg); this.name = 'AssertionError'; } }

function fmt(v) {
  try {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Uint8Array) return `Uint8Array[${Array.from(v).join(',')}]`;
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  } catch (_) { return String(v); }
}
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}
export function assert(cond, msg) { if (!cond) throw new AssertionError(msg || 'assertion failed'); }
export function assertEquals(actual, expected, msg) {
  if (!deepEqual(actual, expected)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)}, got ${fmt(actual)}`);
}
export function assertStrictEquals(actual, expected, msg) {
  if (!Object.is(actual, expected)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)} (strict), got ${fmt(actual)}`);
}
export function assertMatch(actual, re, msg) {
  if (typeof actual !== 'string' || !re.test(actual)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(actual)} to match ${re}`);
}
export async function assertRejects(fn, ErrorClass, msgIncludes) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  if (!threw) throw new AssertionError('expected promise to reject');
  if (ErrorClass && !(threw instanceof ErrorClass)) throw new AssertionError(`expected rejection of type ${ErrorClass.name}, got ${threw && threw.name}: ${threw && threw.message}`);
  if (msgIncludes && !String(threw.message).includes(msgIncludes)) throw new AssertionError(`expected rejection message to include ${fmt(msgIncludes)}, got ${fmt(threw.message)}`);
  return threw;
}
