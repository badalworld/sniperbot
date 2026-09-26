'use strict';
/* HTTP server: static dashboard + REST API + SSE live stream (updates every second). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

class WebServer {
  constructor(engine, port) {
    this.engine = engine;
    this.port = port;
    this.sseClients = new Set();
    this.server = null;
    this.sseTimer = null;
  }

  start() {
    this.server = http.createServer((req, res) => this.route(req, res).catch((e) => {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); } catch (e2) {}
    }));
    this.server.listen(this.port, '0.0.0.0', () => {
      require('./util').logger.info('Dashboard ready →  http://localhost:' + this.port + '  (LAN: http://<your-ip>:' + this.port + ')');
    });
    this.sseTimer = setInterval(() => this.broadcast(), 1000);
  }

  stop() { clearInterval(this.sseTimer); if (this.server) this.server.close(); }

  broadcast() {
    if (!this.sseClients.size) return;
    let payload;
    try { payload = JSON.stringify(this.engine.dashboard()); } catch (e) { return; }
    for (const res of this.sseClients) {
      try { res.write('event: snapshot\ndata: ' + payload + '\n\n'); } catch (e) { this.sseClients.delete(res); }
    }
  }

  async route(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === '/api/stream') return this.sse(req, res);
    if (p.startsWith('/api/')) return this.api(req, res, u);
    return this.static(req, res, p);
  }

  sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    this.sseClients.add(res);
    try { res.write('event: snapshot\ndata: ' + JSON.stringify(this.engine.dashboard()) + '\n\n'); } catch (e) {}
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(hb); this.sseClients.delete(res); });
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 200 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
      req.on('error', reject);
    });
  }

  async api(req, res, u) {
    const e = this.engine;
    const p = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') return send(204, {});

    if (p === '/api/state' && req.method === 'GET') return send(200, e.dashboard());

    if (p === '/api/start' && req.method === 'POST') {
      const body = await this.readBody(req);
      const r = await e.start(body);
      return send(r.ok ? 200 : 400, r);
    }
    if (p === '/api/stop' && req.method === 'POST') {
      const body = await this.readBody(req);
      const r = await e.stop(Boolean(body.closePositions));
      return send(r.ok ? 200 : 400, r);
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await this.readBody(req);
      const s = e.updateSettings(body, { apiKey: body.apiKey, secretKey: body.secretKey });
      return send(200, { ok: true, settings: e.maskedSettings() });
    }
    if (p === '/api/position/close' && req.method === 'POST') {
      const body = await this.readBody(req);
      const pos = e.positions.get(String(body.symbol || '').toUpperCase());
      if (!pos) return send(404, { ok: false, error: 'No open bot position on ' + body.symbol });
      e.closePosition(pos, 'Manual close from dashboard', 'MANUAL').catch(() => {});
      return send(200, { ok: true });
    }
    if (p === '/api/position/closeAll' && req.method === 'POST') {
      let n = 0;
      for (const pos of Array.from(e.positions.values())) { e.closePosition(pos, 'Close all (dashboard)', 'MANUAL').catch(() => {}); n++; }
      return send(200, { ok: true, closing: n });
    }
    if (p === '/api/archive' && req.method === 'GET') {
      return send(200, {
        ok: true,
        completed: e.completed.slice().reverse(),
        sessions: e.sessions,
        stats: e.seasonStats(),
        season: e.season,
      });
    }
    if (p === '/api/analyze' && req.method === 'GET') {
      const symbol = String(u.searchParams.get('symbol') || '').toUpperCase();
      if (!symbol || !symbol.includes('_')) return send(400, { ok: false, error: 'symbol required (e.g. BTC_USDT)' });
      try {
        const r = await e.evaluateAi(symbol, {});
        return send(200, { ok: true, analysis: r, weights: require('./aiscore').WEIGHTS });
      } catch (er) { return send(500, { ok: false, error: er.message }); }
    }
    if (p === '/api/ip' && req.method === 'GET') {
      const { publicIP, localIPs } = require('./util');
      const pub = await publicIP();
      return send(200, { ok: true, public: pub, lan: localIPs(), port: e.settings.port });
    }
    return send(404, { ok: false, error: 'unknown endpoint' });
  }

  static(req, res, pathname) {
    let p = decodeURIComponent(pathname);
    if (p === '/' || p === '/index.html' || p === '/dashboard') p = '/index.html';
    if (p === '/marketscan' || p === '/scan') p = '/marketscan.html';
    if (p === '/archive' || p === '/history') p = '/archive.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 — not found'); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }
}

module.exports = { WebServer };
