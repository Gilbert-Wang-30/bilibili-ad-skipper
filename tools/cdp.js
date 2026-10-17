// Minimal Chrome DevTools Protocol client for Deno — used to drive a scratch-profile browser that has the
// unpacked extension loaded (see tools/launch-test-browser.sh / README "开发测试").
// Usage: deno run --allow-net --allow-write --allow-read --allow-env tools/cdp.js <cmd> [args]
//   targets                         list page targets
//   new <url>                       open a new tab, print its target id
//   nav <target> <url>              navigate (target = id or url substring)
//   eval <target> <js>              evaluate (await) and print JSON result
//   evalfile <target> <file.js>     evaluate a script file
//   shot <target> <out.jpg>         screenshot (jpeg)
//   console <target> <seconds>      stream console messages for N seconds
//   close <target>
const PORT = Deno.env.get('CDP_PORT') || '9333';
const base = `http://127.0.0.1:${PORT}`;

async function listTargets() { return (await fetch(`${base}/json/list`)).json(); }
async function findTarget(key) {
  const ts = await listTargets();
  return ts.find((t) => t.id === key) || ts.find((t) => t.type === 'page' && t.url.includes(key)) || ts.find((t) => t.url.includes(key));
}
class Session {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
        else if (msg.method) for (const l of this.listeners) l(msg);
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (e) {} }
}
async function withTarget(key, fn) {
  const t = await findTarget(key);
  if (!t) throw new Error('target not found: ' + key);
  const s = await new Session(t.webSocketDebuggerUrl).connect();
  try { return await fn(s, t); } finally { s.close(); }
}
async function withBrowser(fn) {
  const v = await (await fetch(`${base}/json/version`)).json();
  const s = await new Session(v.webSocketDebuggerUrl).connect();
  try { return await fn(s); } finally { s.close(); }
}
const [cmd, ...args] = Deno.args;
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 1));
// A multi-line script (file) is used as an async function body (it must `return`); a one-liner is treated as an expression.
const wrapExpr = (expression) => `(async () => { ${/^\s*return\b/.test(expression) || expression.includes('\n') ? expression : 'return (' + expression + ')'} })()`;
switch (cmd) {
  // Requires the browser to be launched with --enable-unsafe-extension-debugging (Chrome 126+).
  case 'loadext': await withBrowser(async (s) => { out(await s.send('Extensions.loadUnpacked', { path: args[0] })); }); break;
  case 'uninstallext': await withBrowser(async (s) => { out(await s.send('Extensions.uninstall', { id: args[0] })); }); break;
  case 'btargets': await withBrowser(async (s) => { const r = await s.send('Target.getTargets'); out(r.targetInfos.map((t) => ({ id: t.targetId, type: t.type, url: t.url.slice(0, 120) }))); }); break;
  case 'targets': out((await listTargets()).map((t) => ({ id: t.id, type: t.type, url: t.url.slice(0, 120), title: (t.title || '').slice(0, 60) }))); break;
  case 'new': { const r = await (await fetch(`${base}/json/new?${encodeURIComponent(args[0] || 'about:blank')}`, { method: 'PUT' })).json(); out({ id: r.id, url: r.url }); break; }
  case 'close': { const t = await findTarget(args[0]); if (t) await fetch(`${base}/json/close/${t.id}`); out('closed'); break; }
  case 'nav': await withTarget(args[0], async (s) => { await s.send('Page.enable'); await s.send('Page.navigate', { url: args[1] }); out('navigated'); }); break;
  case 'eval':
  case 'evalfile': {
    const expression = cmd === 'evalfile' ? await Deno.readTextFile(args[1]) : args[1];
    await withTarget(args[0], async (s) => {
      const r = await s.send('Runtime.evaluate', { expression: wrapExpr(expression), awaitPromise: true, returnByValue: true, timeout: 60000 });
      if (r.exceptionDetails) out({ error: r.exceptionDetails.text, detail: r.exceptionDetails.exception && r.exceptionDetails.exception.description });
      else out(r.result.value === undefined ? { type: r.result.type, description: r.result.description } : r.result.value);
    });
    break;
  }
  case 'contexts':
  case 'evalcs': {
    // Evaluate inside the extension's ISOLATED content-script world (context name = extension id, or any non-default world).
    const expression = cmd === 'evalcs' ? (args[1].endsWith('.js') ? await Deno.readTextFile(args[1]) : args[1]) : null;
    await withTarget(args[0], async (s) => {
      const contexts = [];
      s.on((m) => { if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context); });
      await s.send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 300));
      if (cmd === 'contexts') { out(contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, aux: c.auxData }))); return; }
      const extId = Deno.env.get('BAS_EXT_ID') || '';
      // After an extension reload the page can hold several worlds with the same name: newest one that has BAS wins.
      const isolated = contexts.filter((c) => (extId && ((c.origin || '').includes(extId) || (c.name || '').includes(extId))) || (c.auxData && (c.auxData.type === 'isolated' || c.auxData.isDefault === false)))
        .sort((a, b) => b.id - a.id);
      let ctx = null;
      for (const c of isolated) {
        try {
          const probe = await s.send('Runtime.evaluate', { contextId: c.id, expression: "typeof BAS !== 'undefined' && !!BAS.state", returnByValue: true });
          if (probe.result && probe.result.value === true) { ctx = c; break; }
        } catch (e) { /* context gone */ }
      }
      ctx = ctx || isolated[0];
      if (!ctx) { out({ error: 'no isolated world found', contexts: contexts.map((c) => c.name) }); return; }
      const r = await s.send('Runtime.evaluate', { contextId: ctx.id, expression: wrapExpr(expression), awaitPromise: true, returnByValue: true, timeout: 60000 });
      if (r.exceptionDetails) out({ error: r.exceptionDetails.text, detail: r.exceptionDetails.exception && r.exceptionDetails.exception.description });
      else out(r.result.value === undefined ? { type: r.result.type, description: r.result.description } : r.result.value);
    });
    break;
  }
  case 'shot': await withTarget(args[0], async (s) => {
    const r = await s.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    await Deno.writeFile(args[1], Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
    out('saved ' + args[1]);
  }); break;
  case 'console': await withTarget(args[0], async (s) => {
    const secs = Number(args[1] || 5);
    s.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') out(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || a.type)).join(' '));
      if (m.method === 'Runtime.exceptionThrown') out('[exception] ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    });
    await s.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, secs * 1000));
  }); break;
  default: out('unknown command'); Deno.exit(1);
}
