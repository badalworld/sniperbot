'use strict';
/* MEXC Futures (Contract) REST client — official v1 API.
 * Signing (per official docs):
 *   - headers: ApiKey, Request-Time (ms), Signature, Content-Type: application/json, Recv-Window (optional)
 *   - signature = HMAC_SHA256(secretKey, accessKey + timestamp + paramString)
 *   - GET:  paramString = business params sorted alphabetically joined key=value&key2=value2 (null params excluded)
 *   - POST: paramString = exact JSON body string (no sorting)
 * Base domain: https://api.mexc.com (primary since 2026-01), fallback https://contract.mexc.com
 */
const crypto = require('crypto');
const { http, RateLimiter, sleep, logger } = require('./util');

const PRIMARY = 'https://api.mexc.com';
const FALLBACK = 'https://contract.mexc.com';

class MexcClient {
  constructor(opts) {
    opts = opts || {};
    this.apiKey = opts.apiKey || '';
    this.secret = opts.secretKey || '';
    this.recvWindow = opts.recvWindow || 10000;
    this.limiter = new RateLimiter(8, 14); // official limit ~20/2s per endpoint; global bucket keeps us safe
    this.pingMs = null;
    this.lastPingTs = 0;
  }

  setKeys(apiKey, secretKey) { this.apiKey = apiKey || ''; this.secret = secretKey || ''; }

  _sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  /* GET with auth. params: plain object of business params */
  async privateGet(path, params) {
    await this.limiter.take();
    const qs = buildQuery(params || {});
    const ts = Date.now().toString();
    const signature = this._sign(this.apiKey + ts + qs);
    const url = `${PRIMARY}${path}${qs ? '?' + qs : ''}`;
    const headers = {
      'ApiKey': this.apiKey,
      'Request-Time': ts,
      'Signature': signature,
      'Recv-Window': String(this.recvWindow),
      'Content-Type': 'application/json',
    };
    let res, err;
    try {
      res = await http.requestJson(url, { method: 'GET', headers, timeout: 10000 });
      if (res.status === 0) throw new Error('network');
    } catch (e) { err = e; }
    if (!res || res.status >= 500 || !res.json) {
      // fallback host retry once
      try {
        await this.limiter.take();
        const ts2 = Date.now().toString();
        const sig2 = this._sign(this.apiKey + ts2 + qs);
        res = await http.requestJson(`${FALLBACK}${path}${qs ? '?' + qs : ''}`, {
          method: 'GET',
          headers: { 'ApiKey': this.apiKey, 'Request-Time': ts2, 'Signature': sig2, 'Recv-Window': String(this.recvWindow), 'Content-Type': 'application/json' },
          timeout: 10000,
        });
      } catch (e2) { throw err || e2; }
    }
    if (!res.json) throw new Error('MEXC: non-JSON response (HTTP ' + res.status + ')');
    return res.json;
  }

  /* POST with auth. bodyObj serialized exactly as sent (signature covers exact JSON string) */
  async privatePost(path, bodyObj) {
    await this.limiter.take();
    const body = JSON.stringify(bodyObj || {});
    const ts = Date.now().toString();
    const signature = this._sign(this.apiKey + ts + body);
    const headers = {
      'ApiKey': this.apiKey,
      'Request-Time': ts,
      'Signature': signature,
      'Recv-Window': String(this.recvWindow),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    let res, err;
    try {
      res = await http.requestJson(`${PRIMARY}${path}`, { method: 'POST', headers, body, timeout: 10000 });
    } catch (e) { err = e; }
    if (!res || res.status >= 500 || !res.json) {
      try {
        await this.limiter.take();
        const ts2 = Date.now().toString();
        const sig2 = this._sign(this.apiKey + ts2 + body);
        res = await http.requestJson(`${FALLBACK}${path}`, {
          method: 'POST',
          headers: { 'ApiKey': this.apiKey, 'Request-Time': ts2, 'Signature': sig2, 'Recv-Window': String(this.recvWindow), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          body, timeout: 10000,
        });
      } catch (e2) { throw err || e2; }
    }
    if (!res.json) throw new Error('MEXC: non-JSON response (HTTP ' + res.status + ')');
    return res.json;
  }

  async publicGet(path, params) {
    await this.limiter.take();
    const qs = buildQuery(params || {});
    const url = `${PRIMARY}${path}${qs ? '?' + qs : ''}`;
    let res;
    try {
      res = await http.requestJson(url, { timeout: 9000 });
    } catch (e) {
      res = await http.requestJson(`${FALLBACK}${path}${qs ? '?' + qs : ''}`, { timeout: 9000 });
    }
    if (!res.json) throw new Error('MEXC: non-JSON response (HTTP ' + res.status + ') ' + path);
    return res.json;
  }

  /* ---------- public market data ---------- */
  async ping() {
    const t0 = Date.now();
    await this.publicGet('/api/v1/contract/ping');
    this.pingMs = Date.now() - t0;
    this.lastPingTs = Date.now();
    return this.pingMs;
  }

  async tickers() { // all contracts
    const j = await this.publicGet('/api/v1/contract/ticker');
    if (!j.success) throw new Error('tickers failed: ' + (j.message || j.code));
    return Array.isArray(j.data) ? j.data : [j.data];
  }
  async ticker(symbol) {
    const j = await this.publicGet('/api/v1/contract/ticker', { symbol });
    if (!j.success) throw new Error('ticker failed: ' + (j.message || j.code));
    return j.data;
  }
  async details() { // all contract details (contractSize, leverage limits, state...)
    const j = await this.publicGet('/api/v1/contract/detail');
    if (!j.success) throw new Error('detail failed: ' + (j.message || j.code));
    return Array.isArray(j.data) ? j.data : [j.data];
  }
  /* interval: Min1,Min5,Min15,Min30,Min60,Hour4,Hour8,Day1 ; start/end unix SECONDS. Max 2000 points. */
  async kline(symbol, interval, count) {
    const step = INTERVAL_SEC[interval] || 60;
    const end = Math.floor(Date.now() / 1000);
    const start = end - count * step - step; // small buffer
    const j = await this.publicGet(`/api/v1/contract/kline/${encodeURIComponent(symbol)}`, { interval, start });
    if (!j.success || !j.data) throw new Error('kline failed ' + symbol + ': ' + (j.message || j.code));
    const d = j.data;
    const n = (d.time || []).length;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ t: d.time[i], open: +d.open[i], high: +d.high[i], low: +d.low[i], close: +d.close[i], vol: +d.vol[i], amount: +d.amount[i] });
    }
    return out;
  }
  async fundingRate(symbol) {
    const j = await this.publicGet(`/api/v1/contract/funding_rate/${encodeURIComponent(symbol)}`);
    if (!j.success) throw new Error('funding failed: ' + (j.message || j.code));
    return j.data; // {symbol, fundingRate, nextSetTime, idxPrice, fairPrice}
  }

  /* ---------- private trading ---------- */
  async assets() { // array of {currency, equity, availableBalance, ...}
    const j = await this.privateGet('/api/v1/private/account/assets');
    if (!j.success) throw new Error('assets failed: ' + (j.message || j.code));
    return j.data || [];
  }
  async usdt() {
    const list = await this.assets();
    return list.find((a) => a.currency === 'USDT') || null;
  }
  async openPositions(symbol) {
    const params = symbol ? { symbol } : {};
    const j = await this.privateGet('/api/v1/private/position/open_positions', params);
    if (!j.success) throw new Error('open_positions failed: ' + (j.message || j.code));
    return j.data || [];
  }
  async historyPositions(pageNum, pageSize) {
    const j = await this.privateGet('/api/v1/private/position/list', { page_num: pageNum || 1, page_size: pageSize || 20 });
    if (!j.success) throw new Error('position history failed: ' + (j.message || j.code));
    return j.data || [];
  }
  /* market order. side: 1 open long, 3 open short, 2 close short, 4 close long */
  async createOrder(o) {
    const body = {
      symbol: o.symbol,
      price: o.price,
      vol: o.vol,
      side: o.side,
      type: o.type == null ? 5 : o.type, // 5 = market
      openType: o.openType == null ? 1 : o.openType, // 1 = isolated
    };
    if (o.leverage) body.leverage = o.leverage;
    if (o.positionId) body.positionId = o.positionId;
    if (o.stopLossPrice) { body.stopLossPrice = o.stopLossPrice; body.lossTrend = 1; }
    if (o.takeProfitPrice) { body.takeProfitPrice = o.takeProfitPrice; body.profitTrend = 1; }
    if (o.externalOid) body.externalOid = o.externalOid;
    const j = await this.privatePost('/api/v1/private/order/create', body);
    if (!j.success) throw new Error('order/create failed: ' + (j.message || j.code));
    return j.data; // {orderId, ts}
  }
}

function buildQuery(params) {
  const keys = Object.keys(params).filter((k) => params[k] !== null && params[k] !== undefined).sort();
  return keys.map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
}

const INTERVAL_SEC = {
  Min1: 60, Min3: 180, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400,
};

module.exports = { MexcClient, INTERVAL_SEC, PRIMARY, FALLBACK };
