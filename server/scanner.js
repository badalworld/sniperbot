'use strict';
/* Market scanner — continuously scans MEXC futures markets.
 * - Refreshes ALL tickers every ~3s (single call) for price/24h-vol/24h-change.
 * - Rotates through eligible symbols computing 15m/3m metrics + quick AI bias (LONG/SHORT/NEUTRAL).
 * - Keeps a rolling list of the latest 40 scanned rows (older ones drop off) with entry animations on UI.
 * - Enriches displayed symbols with market cap (CoinGecko, best-effort, cached 10 min). */
const { MexcClient, INTERVAL_SEC } = require('./mexc');
const ind = require('./indicators');
const ai = require('./aiscore');
const { logger, http } = require('./util');

class Scanner {
  constructor(client) {
    this.client = client || new MexcClient({});
    this.tickers = new Map();      // symbol -> ticker object
    this.details = new Map();      // symbol -> detail object
    this.eligible = [];            // symbols passing volume/state filters
    this.rows = [];                // rolling display rows (max 40)
    this.bySymb = new Map();       // symbol -> row
    this.klineCache = new Map();   // key symbol|interval -> {ts, candles}
    this.oiHistory = new Map();    // symbol -> [{t, holdVol}]
    this.scanCursor = 0;
    this.lastScanTs = 0;
    this.stats = { universe: 0, eligible: 0, scanned: 0, cycles: 0 };
    this.minVolume = 5000000;
    this.mcapCache = new Map();    // baseCoin -> {ts, mcap}
    this.mcapLastFetch = 0;
    this.timer = null;
    this.fastTimer = null;
    this.running = true;
  }

  setMinVolume(v) { this.minVolume = Math.max(0, Number(v) || 0); }

  async init() {
    try { await this.refreshDetails(); } catch (e) { logger.error('scanner init details: ' + e.message); }
    await this.refreshTickers().catch((e) => logger.warn('scanner init tickers: ' + e.message));
    this.loopDetails = setInterval(() => this.refreshDetails().catch(() => {}), 10 * 60 * 1000);
    this.timer = setInterval(() => this.refreshTickers().catch((e) => logger.debug('tickers: ' + e.message)), 3000);
    this.fastTimer = setInterval(() => this.scanBatch().catch((e) => logger.debug('scanBatch: ' + e.message)), 1000);
    this.mcapTimer = setInterval(() => this.refreshMarketCaps().catch(() => {}), 5 * 60 * 1000);
  }

  stop() { this.running = false; clearInterval(this.timer); clearInterval(this.fastTimer); clearInterval(this.loopDetails); clearInterval(this.mcapTimer); }

  async refreshDetails() {
    try {
      const all = await this.client.details();
      const map = new Map();
      for (const d of all) map.set(d.symbol, d);
      this.details = map;
      logger.info('scanner: ' + map.size + ' contract details loaded');
    } catch (e) { logger.warn('refreshDetails: ' + e.message); }
  }

  async refreshTickers() {
    const all = await this.client.tickers();
    const now = Date.now();
    for (const t of all) {
      this.tickers.set(t.symbol, t);
      // AUDIT FIX: track OI history only for tradeable USDT pairs (was: every
      // contract on the exchange -> hundreds of dead arrays growing forever)
      if (t.symbol && t.symbol.endsWith('_USDT') && (+t.amount24 || 0) >= this.minVolume * 0.5) {
        let h = this.oiHistory.get(t.symbol);
        if (!h) { h = []; this.oiHistory.set(t.symbol, h); }
        h.push({ t: now, holdVol: +t.holdVol || 0 });
        if (h.length > 320) h.splice(0, h.length - 320); // 15 min @ 3s + margin
      }
    }
    // eligible universe: *_USDT contracts enabled by exchange + state + min 24h turnover
    const out = [];
    for (const [s, t] of this.tickers) {
      if (!s.endsWith('_USDT')) continue;
      const d = this.details.get(s);
      if (d && (d.state === 0 || d.state === '0' || d.state === 'ENABLED')) {
        if ((+t.amount24 || 0) >= this.minVolume) out.push(s);
      }
    }
    out.sort((a, b) => (+this.tickers.get(b).amount24 || 0) - (+this.tickers.get(a).amount24 || 0));
    this.eligible = out;
    this.stats.universe = this.tickers.size;
    this.stats.eligible = out.length;
    this.lastScanTs = now;
  }

  /* rotate through eligible symbols, ~8 per second */
  async scanBatch() {
    if (!this.eligible.length) return;
    const BATCH = 8;
    const batch = [];
    for (let i = 0; i < BATCH; i++) {
      batch.push(this.eligible[this.scanCursor % this.eligible.length]);
      this.scanCursor++;
    }
    for (const s of batch) {
      try { await this.scanSymbol(s); } catch (e) { /* keep rotating */ }
    }
    this.stats.cycles++;
  }

  async scanSymbol(symbol) {
    const k15 = await this.klines(symbol, 'Min15', 70);
    const closed15 = ind.dropForming(k15, INTERVAL_SEC.Min15);
    if (closed15.length < 30) return;
    const t = this.tickers.get(symbol) || {};
    const q = ai.quickEvaluate(symbol, closed15, t);
    // 15m change (latest closed candle vs previous close)
    const chg15 = closed15.length >= 2 ? (closed15[closed15.length - 1].close - closed15[closed15.length - 2].close) / closed15[closed15.length - 2].close * 100 : 0;
    const d = this.details.get(symbol) || {};
    const oiVal = (+t.holdVol || 0) * (+d.contractSize || 0) * (+t.fairPrice || +t.lastPrice || 0);
    const row = {
      symbol,
      price: +t.lastPrice || ind.last(closed15).close,
      change24h: (+t.riseFallRate || 0) * 100,
      change15m: chg15,
      vol24h: +t.amount24 || 0,
      oiValue: oiVal,
      fundingRate: +t.fundingRate || 0,
      direction: q.direction,
      quickScore: q.score,
      contractSize: +d.contractSize || 0,
      maxLeverage: +d.maxLeverage || 20,
      mcap: this.mcapCache.get((d.baseCoin || '').toUpperCase())?.mcap || null,
      spark: closed15.slice(-24).map((c) => +c.close.toFixed(6)), // 15m trend sparkline (last 6h)
      scannedAt: Date.now(),
    };
    const existing = this.bySymb.get(symbol);
    this.bySymb.set(symbol, row);
    if (!existing) {
      this.rows.unshift(row);
      row.isNew = true;
      setTimeout(() => { row.isNew = false; }, 4000);
    } else {
      Object.assign(existing, row, { isNew: false });
    }
    this.stats.scanned++;
    // cap at 40 rows — oldest removed
    if (this.rows.length > 40) {
      const removed = this.rows.splice(40);
      for (const r of removed) if (this.bySymb.get(r.symbol) === r) this.bySymb.delete(r.symbol);
    }
  }

  async klines(symbol, interval, count) {
    const key = symbol + '|' + interval;
    const c = this.klineCache.get(key);
    const ttl = interval === 'Min15' ? 45000 : interval === 'Min1' ? 20000 : 90000;
    if (c && Date.now() - c.ts < ttl) return c.candles;
    const candles = await this.client.kline(symbol, interval, count);
    // delete-first keeps Map insertion order fresh so eviction never drops hot entries
    this.klineCache.delete(key);
    this.klineCache.set(key, { ts: Date.now(), candles });
    if (this.klineCache.size > 3000) {
      // evict oldest third
      const keys = Array.from(this.klineCache.keys()).slice(0, 1000);
      for (const k of keys) this.klineCache.delete(k);
    }
    return candles;
  }

  /* OI 15 minutes ago (contracts) */
  oi15mAgo(symbol) {
    const h = this.oiHistory.get(symbol);
    if (!h || h.length < 5) return null;
    const target = Date.now() - 15 * 60 * 1000;
    let best = null;
    for (const p of h) { if (p.t <= target) best = p; else break; }
    return best ? best.holdVol : (h[0] ? h[0].holdVol : null);
  }

  async refreshMarketCaps() {
    // best-effort market cap for currently displayed symbols via CoinGecko
    const symbols = Array.from(new Set(this.rows.map((r) => r.symbol)));
    const bases = Array.from(new Set(symbols.map((s) => s.split('_')[0].toUpperCase())));
    const need = bases.filter((b) => {
      const c = this.mcapCache.get(b);
      return !c || Date.now() - c.ts > 10 * 60 * 1000;
    }).slice(0, 80);
    if (!need.length) return;
    try {
      const data = await coingeckoMarketCaps(need);
      for (const [base, mcap] of Object.entries(data)) this.mcapCache.set(base, { ts: Date.now(), mcap });
    } catch (e) {
      logger.debug('mcap enrich: ' + e.message);
    }
  }

  snapshot() {
    return {
      rows: this.rows,
      stats: Object.assign({}, this.stats, { lastScan: this.lastScanTs, now: Date.now(), minVolume: this.minVolume }),
    };
  }

  /* top candidates for the engine, sorted by quick score & volume */
  candidates(limit) {
    return this.eligible.slice(0, Math.max(limit * 3, 60));
  }
  price(symbol) {
    const t = this.tickers.get(symbol);
    return t ? +t.lastPrice : null;
  }
  fairPrice(symbol) {
    const t = this.tickers.get(symbol);
    return t ? (+t.fairPrice || +t.lastPrice) : null;
  }
}

async function coingeckoMarketCaps(bases) {
  const CG_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', BNB: 'binancecoin', DOGE: 'dogecoin',
    ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink', TON: 'the-open-network', TRX: 'tron', DOT: 'polkadot',
    SUI: 'sui', PEPE: 'pepe', SHIB: 'shiba-inu', LTC: 'litecoin', BCH: 'bitcoin-cash', NEAR: 'near', APT: 'aptos',
    ARB: 'arbitrum', OP: 'optimism', ATOM: 'cosmos', FIL: 'filecoin', ETC: 'ethereum-classic', XLM: 'stellar',
    HBAR: 'hedera-hashgraph', INJ: 'injective-protocol', SEI: 'sei-network', TIA: 'celestia', WIF: 'dogwifcoin',
    BONK: 'bonk', FLOKI: 'floki', AAVE: 'aave', UNI: 'uniswap', RENDER: 'render-token', FET: 'fetch-ai',
    JUP: 'jupiter-exchange-solana', PYTH: 'pyth-network', ENA: 'ethena', ONDO: 'ondo-finance', WLD: 'worldcoin',
    KAS: 'kaspa', ALGO: 'algorand', VET: 'vechain', ICP: 'internet-computer', STX: 'blockstack', IMX: 'immutable-x',
    GALA: 'gala', SAND: 'the-sandbox', MANA: 'decentraland', AXS: 'axie-infinity', CRV: 'curve-dao-token',
    LDO: 'lido-dao', MKR: 'maker', GRT: 'the-graph', EOS: 'eos', XTZ: 'tezos', THETA: 'theta-token', RUNE: 'thorchain',
    ORDI: 'ordinals', STRK: 'starknet', ZK: 'zk-sync', MNT: 'mantle', ETHFI: 'ether-fi',
  };
  const ids = bases.map((b) => CG_IDS[b]).filter(Boolean);
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=' + chunk.join(',');
    const r = await http.requestJson(url, { timeout: 8000 });
    if (r.json && Array.isArray(r.json)) {
      for (const c of r.json) out[String(c.symbol || '').toUpperCase()] = c.market_cap || null;
    }
  }
  return out;
}

module.exports = { Scanner };
