// Worker thread that serves apps-script/Code.gs like a deployed Apps Script web app:
//   POST /exec  -> runs doPost(), answers 302 to /echo?id=... (exactly like script.google.com)
//   GET  /echo  -> returns the stored doPost() output
// plus test-only endpoints to drive the Chat side:
//   POST /__chat     { fn, event }  -> runs onMessage/onCardAction/... and returns its result
//   GET  /__state                   -> props, pushes, sheets
//   POST /__offline  { offline }    -> simulate an outage (503 for every relay request)
//   POST /__props    { set, del }   -> edit Script Properties
//   POST /__run      { fn }         -> run a top-level function (e.g. housekeeping)
// Runs in a worker because Utilities.sleep() blocks, as it does in Apps Script.
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { createGasRuntime } from './gas-runtime.js';

const { codePath, props, activeUserEmail } = workerData;
let failChatApi = false;
const chatMessages = new Map();

const { context, store } = createGasRuntime({
  codePath,
  props,
  activeUserEmail,
  fetchHandler: (url, opts, st) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return { code: 200, body: JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }) };
    if (url.startsWith('https://chat.googleapis.com/v1/')) {
      if (failChatApi) return { code: 503, body: '{"error":"unavailable"}' };
      const msg = JSON.parse(opts.payload || '{}');
      const m = /v1\/(spaces\/[^/]+)\/messages(?:\?messageId=(client-[\w-]+))?$/.exec(url);
      if (m && (opts.method || 'get').toLowerCase() === 'post') {
        const name = `${m[1]}/messages/${m[2] || 'm' + st.pushes.length}`;
        if (chatMessages.has(name)) return { code: 409, body: '{"error":"ALREADY_EXISTS"}' };
        chatMessages.set(name, msg);
        st.pushes.push({ kind: 'create', name, msg });
        return { code: 200, body: JSON.stringify({ name }) };
      }
      const p = /v1\/(spaces\/[^?]+)\?updateMask/.exec(url);
      if (p && (opts.method || '').toLowerCase() === 'patch') {
        chatMessages.set(p[1], msg);
        st.pushes.push({ kind: 'patch', name: p[1], msg });
        return { code: 200, body: '{}' };
      }
    }
    if (url.startsWith('https://chat.googleapis.com/v1/spaces/WEBHOOK')) {
      st.pushes.push({ kind: 'webhook', msg: JSON.parse(opts.payload) });
      return { code: 200, body: '{}' };
    }
    return { code: 404, body: 'unknown url' };
  },
});

let offline = false;
const outputs = new Map();
let seq = 0;

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  try {
    if (url.pathname === '/exec' && req.method === 'POST') {
      if (offline) return send(503, '<html>Service unavailable</html>', 'text/html');
      const contents = await body(req);
      const out = context.doPost({ postData: { contents, type: 'application/json' } });
      const id = String(++seq);
      outputs.set(id, out.content);
      res.writeHead(302, { location: `/echo?id=${id}` });
      return res.end();
    }
    if (url.pathname === '/echo') {
      const out = outputs.get(url.searchParams.get('id'));
      outputs.delete(url.searchParams.get('id'));
      return out ? send(200, out) : send(404, 'gone', 'text/plain');
    }
    if (url.pathname === '/__chat') {
      const { fn, event, activeUser } = JSON.parse(await body(req));
      store.activeUserEmail = activeUser ?? workerData.activeUserEmail;
      return send(200, { result: context[fn](event) ?? null });
    }
    if (url.pathname === '/__call') {
      const { fn, args = [], activeUser } = JSON.parse(await body(req));
      store.activeUserEmail = activeUser ?? workerData.activeUserEmail;
      try {
        const r = context[fn](...args);
        return send(200, { result: r && typeof r === 'object' && 'content' in r ? { html: r.content } : r ?? null });
      } catch (err) {
        return send(200, { thrown: err.message });
      }
    }
    if (url.pathname === '/__gmail') return send(200, { id: store.gmailInject(JSON.parse(await body(req))) });
    if (url.pathname === '/__state') return send(200, { props: store.props, pushes: store.pushes, sheets: Object.fromEntries([...store.sheets].map(([k, v]) => [k, v.rows])), triggers: store.triggers.length, gmail: [...store.gmail.threads.values()], gmailSearches: store.gmail.calls || 0 });
    if (url.pathname === '/__offline') {
      offline = !!JSON.parse(await body(req)).offline;
      return send(200, { offline });
    }
    if (url.pathname === '/__chatapi') {
      failChatApi = !!JSON.parse(await body(req)).fail;
      return send(200, { failChatApi });
    }
    if (url.pathname === '/__props') {
      const { set = {}, del = [] } = JSON.parse(await body(req));
      Object.assign(store.props, set);
      del.forEach((k) => delete store.props[k]);
      return send(200, { ok: true });
    }
    if (url.pathname === '/__run') {
      const { fn } = JSON.parse(await body(req));
      return send(200, { result: context[fn]() ?? null });
    }
    send(404, { error: 'not found' });
  } catch (err) {
    send(500, { error: err.message, stack: err.stack });
  }
});

server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
