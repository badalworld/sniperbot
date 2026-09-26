'use strict';
/* MEXC AI Fusion — shared utilities: logger, https client, rate limiter, math helpers. */
const https = require('https');
const { URL } = require('url');
const os = require('os');

/* ---------------- logger ---------------- */
const logs = [];
const LOG_MAX = 300;
function log(level, msg, extra) {
  const entry = { ts: Date.now(), level, msg: String(msg) };
  if (extra !== undefined) {
    try { entry.extra = typeof extra === 'string' ? extra : JSON.stringify(extra); } catch (e) { entry.extra = String(extra); }
  }
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
  const line = `[${new Date(entry.ts).toISOString()}] [${level.toUpperCase()}] ${entry.msg}${entry.extra ? ' ' + entry.extra : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  return entry;
}
module.exports.logger = {
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
  debug: (m, e) => log('debug', m, e),
  recent: (n) => logs.slice(-(n || 80)),
};

/* ---------------- https client (no external deps) ---------------- */
function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL: ' + urlStr)); }
    const mod = https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({ 'User-Agent': 'MexcAiFusion/2.0 (+local dashboard)' }, headers),
      timeout,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw, headers: res.headers });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timeout after ' + timeout + 'ms')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(urlStr, opts) {
  const r = await request(urlStr, opts);
  let j = null;
  try { j = JSON.parse(r.raw); } catch (e) { /* non json */ }
  return { status: r.status, json: j, raw: r.raw };
}

module.exports.http = { request, requestJson };

/* ---------------- token-bucket rate limiter ---------------- */
class RateLimiter {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec; this.burst = burst || Math.ceil(ratePerSec * 1.5);
    this.tokens = this.burst; this.last = Date.now();
  }
  async take() {
    for (let i = 0; i < 2000; i++) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await sleep(Math.max(30, Math.min(400, (1 - this.tokens) / this.rate * 1000)));
    }
  }
}
module.exports.RateLimiter = RateLimiter;

/* ---------------- misc ---------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
module.exports.sleep = sleep;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
module.exports.clamp = clamp;

function round(v, d) {
  const p = Math.pow(10, d == null ? 2 : d);
  return Math.round((Number(v) + Number.EPSILON) * p) / p;
}
module.exports.round = round;

function fmtUsd(v, d) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const dec = d != null ? d : (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
module.exports.fmtUsd = fmtUsd;

function fmtNum(v, d) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
}
module.exports.fmtNum = fmtNum;

function fmtCompact(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
module.exports.fmtCompact = fmtCompact;

function localIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}
module.exports.localIPs = localIPs;

/* fetch public IP with fallbacks; cached */
let pubIpCache = { ip: null, ts: 0 };
async function publicIP() {
  if (pubIpCache.ip && Date.now() - pubIpCache.ts < 10 * 60 * 1000) return pubIpCache.ip;
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const u of urls) {
    try {
      const r = await request(u, { timeout: 6000 });
      const ip = (r.raw || '').trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) { pubIpCache = { ip, ts: Date.now() }; return ip; }
    } catch (e) { /* try next */ }
  }
  return pubIpCache.ip || null;
}
module.exports.publicIP = publicIP;
