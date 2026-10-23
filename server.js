'use strict';
// Zero-dependency HTTP server:  node server.js   ->  http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path');
const core = require('./lib/core');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const DATA = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f + '.json'), 'utf8'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const summary = st => { const v = core.buildViews(st); return { records: v, metrics: core.metrics(v), importLog: st.importLog, routes: core.ROUTES }; };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      const st = core.load();
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, summary(st));
      if (req.method === 'GET' && p === '/api/metrics') return send(res, 200, core.metrics(core.buildViews(st), { person: u.searchParams.get('person'), type: u.searchParams.get('type') }));
      if (req.method === 'GET' && p === '/api/record') { const v = core.fullView(st, u.searchParams.get('key')); return v ? send(res, 200, v) : send(res, 404, { error: 'not found' }); }
      if (req.method === 'GET' && p === '/api/brief') return send(res, 200, { brief: core.ANALYSIS.brief, views: core.buildViews(st).map(v => ({ ref: v.ref, key: v.key, hasAnalysis: v.hasAnalysis })) });
      if (req.method === 'POST' && p === '/api/import') {
        const b = await readBody(req); const env = b.envelope || DATA(b.file === 'update' ? '02_update' : '01_initial');
        const s = core.importEnvelope(st, env, { shuffle: b.shuffle }); core.save(st); return send(res, 200, { import: s, ...summary(st) });
      }
      if (req.method === 'POST' && p === '/api/demo') {                  // clean start + both batches
        const fresh = core.emptyState(); core.importEnvelope(fresh, DATA('01_initial')); core.importEnvelope(fresh, DATA('02_update')); core.save(fresh); return send(res, 200, summary(fresh));
      }
      if (req.method === 'POST' && p === '/api/override') {
        const b = await readBody(req); if (!st.records[b.key]) return send(res, 404, { error: 'unknown record' });
        const routes = (b.routes || []).filter(r => core.ROUTES[r]); if (!routes.length) return send(res, 400, { error: 'choose at least one route' });
        st.overrides[b.key] = { routes, note: (b.note || '').slice(0, 300), at: new Date().toISOString() }; core.save(st); return send(res, 200, summary(st));
      }
      if (req.method === 'DELETE' && p === '/api/override') { delete st.overrides[u.searchParams.get('key')]; core.save(st); return send(res, 200, summary(st)); }
      if (req.method === 'POST' && p === '/api/reset') { core.save(core.emptyState()); return send(res, 200, summary(core.emptyState())); }
      if (req.method === 'POST' && p === '/api/export') { const e = core.exportAll(st); return send(res, 200, { dir: path.relative(__dirname, e.dir), files: e.files, manifest: e.manifest }); }
      if (req.method === 'GET' && p === '/api/export.zip') { const e = core.exportAll(st); return send(res, 200, core.zipDir(e.dir), 'application/zip'); }
      return send(res, 404, { error: 'no such endpoint' });
    }
    const f = path.join(PUB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(PUB) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Revenue Intelligence Inbox -> http://localhost:${PORT}`));
