"""Build a self-contained injection snippet that loads the content-script pipeline into a bilibili page
without installing the extension (for quick checks through a DevTools console / automation).
It gzips + base64s all content modules and the CSS; the snippet decompresses with DecompressionStream,
installs a tiny chrome.* shim (in-memory storage, no messaging) and evaluates the modules in manifest order.
Usage: python tools/inject-bundle.py > build/inject.js
"""
import base64, gzip, json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
manifest = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
cs = [c for c in manifest['content_scripts'] if c.get('world') != 'MAIN'][0]
bridge = [c for c in manifest['content_scripts'] if c.get('world') == 'MAIN'][0]
parts = []
for js in bridge['js'] + cs['js']:
    src = open(os.path.join(ROOT, js), encoding='utf-8').read()
    parts.append(f"/* ---- {js} ---- */\n{src}\n")
css = '\n'.join(open(os.path.join(ROOT, c), encoding='utf-8').read() for c in cs.get('css', []))
payload = json.dumps({'js': parts, 'css': css})
b64 = base64.b64encode(gzip.compress(payload.encode('utf-8'), 9)).decode()
snippet = r"""
(async () => {
  const b64 = "%s";
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
  const bundle = JSON.parse(text);
  if (!globalThis.chrome || !globalThis.chrome.storage) {
    const mem = { sync: {}, local: {} };
    const area = (n) => ({
      get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: mem[n][k] } : Array.isArray(k) ? Object.fromEntries(k.map(x => [x, mem[n][x]])) : { ...mem[n] }),
      set: (o) => { Object.assign(mem[n], o); return Promise.resolve(); },
      remove: (k) => { for (const x of [].concat(k)) delete mem[n][x]; return Promise.resolve(); },
      clear: () => { mem[n] = {}; return Promise.resolve(); },
    });
    globalThis.chrome = Object.assign(globalThis.chrome || {}, {
      storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {}, removeListener() {} } },
      runtime: { id: 'inject', sendMessage: () => Promise.resolve({ ok: false, error: 'injected mode' }), onMessage: { addListener() {} }, getURL: (p) => p, lastError: undefined },
    });
  }
  const style = document.createElement('style'); style.id = 'bas-injected-css'; style.textContent = bundle.css; document.head.appendChild(style);
  for (const src of bundle.js) { try { (0, eval)(src); } catch (e) { console.error('[BAS inject] module failed', src.slice(0, 60), e); } }
  return 'BAS injected: ' + bundle.js.length + ' modules';
})()
""" % b64
sys.stdout.write(snippet)
sys.stderr.write(f"bundle: {len(payload)} chars raw, {len(b64)} chars b64\n")
