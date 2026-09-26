'use strict';
/* OFFLINE engine pipeline validation (dev-only harness with a stubbed transport).
 * The shipped bot always talks to the real MEXC API — this only proves the wiring:
 * open -> manage -> TP/SL/trail -> compounding -> completed trades -> manual-close detection. */
process.env.PORT = '8099';
process.env.DATA_DIR = require('os').tmpdir() + '/bwf-sim-' + Date.now(); // isolated data dir
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { MexcClient } = require('../server/mexc');
const { Engine } = require('../server/engine');

/* ---- stub transport: behaves like MEXC but in-memory ---- */
class StubClient extends MexcClient {
  constructor(price0) {
    super({});
    this.price = price0;
    this.equity = 32.50;
    this.open = new Map(); // symbol -> exchange position
    this.nextId = 1;
    this.closedTrades = [];
  }
  async usdt() { return { currency: 'USDT', equity: this.equity, availableBalance: this.equity, positionMargin: 0, unrealized: 0, frozenBalance: 0 }; }
  async assets() { return [await this.usdt()]; }
  async openPositions(symbol) {
    const list = Array.from(this.open.entries()).map(([sym, p]) => Object.assign({ symbol: sym }, p));
    return symbol ? list.filter((p) => p.symbol === symbol) : list;
  }
  async createOrder(o) {
    if (o.side === 1 || o.side === 3) {
      const long = o.side === 1;
      const notional = o.vol * 0.01 * this.price; // contractSize 0.01
      const id = this.nextId++;
      this.open.set(o.symbol, {
        positionId: id, symbol: o.symbol, positionType: long ? 1 : 2, state: 1,
        holdVol: o.vol, holdAvgPrice: this.price, im: notional / o.leverage, leverage: o.leverage,
        liquidatePrice: long ? this.price * 0.5 : this.price * 1.5, pnl: 0,
      });
      return { orderId: 'o' + id, ts: Date.now() };
    }
    // close order (side 2 close short, 4 close long)
    const p = this.open.get(o.symbol);
    assert(p, 'close order for unknown position');
    const long = p.positionType === 1;
    const pnl = (this.price - p.holdAvgPrice) / p.holdAvgPrice * p.leverage * p.im * (long ? 1 : -1);
    this.equity += pnl;
    this.closedTrades.push({ symbol: o.symbol, price: this.price, pnl });
    this.open.delete(o.symbol);
    return { orderId: 'c' + this.nextId++, ts: Date.now() };
  }
  async ping() { return 5; }
}

/* ---- price-driven scanner stub ---- */
function makeScanner(stub, ind) {
  const t = { symbol: 'TEST_USDT', lastPrice: stub.price, fairPrice: stub.price, bid1: stub.price * 0.9999, ask1: stub.price * 1.0001, amount24: 50e6, riseFallRate: 0.02, fundingRate: 0.0001, holdVol: 100000, volume24: 1 };
  const candles = [];
  let p = 100;
  for (let i = 0; i < 260; i++) { p *= 1 + (i % 7 < 5 ? 0.004 : -0.002); candles.push({ t: i * 900, open: p / 1.001, high: p * 1.002, low: p * 0.997, close: p, vol: 120 + (i % 5) * 30, amount: p * 100 }); }
  return {
    client: stub,
    tickers: new Map([['TEST_USDT', t]]),
    details: new Map([['TEST_USDT', { symbol: 'TEST_USDT', contractSize: 0.01, maxLeverage: 50, minLeverage: 1, state: 0, priceScale: 4, baseCoin: 'TEST' }]]),
    eligible: ['TEST_USDT'],
    bySymb: new Map([['TEST_USDT', { symbol: 'TEST_USDT', quickScore: 40 }]]),
    klineCache: new Map(),
    klines: async (symbol, interval, count) => candles,
    oi15mAgo: () => 90000,
    price: () => stub.price,
    fairPrice: () => stub.price,
    setMinVolume() {},
    snapshot: () => ({ rows: [], stats: { eligible: 1, universe: 1, scanned: 0, cycles: 0, lastScan: Date.now(), now: Date.now(), minVolume: 5e6 } }),
  };
}

(async () => {
  const stub = new StubClient(100);
  const engine = new Engine(makeScanner(stub));
  engine.scanner.client = stub;

  // inject kline cache for 3m aggregation paths
  const c1m = [];
  let p = 100;
  for (let i = 0; i < 140; i++) { p *= 1.002; c1m.push({ t: Math.floor(Date.now() / 1000) - (140 - i) * 60, open: p / 1.002, high: p * 1.001, low: p * 0.998, close: p, vol: 100, amount: 100 }); }
  engine.scanner.klineCache.set('TEST_USDT|Min1', { ts: Date.now(), candles: c1m });

  // start with keys (stub transport accepts anything)
  engine.client = stub;
  const r = await engine.start({ apiKey: 'k', secretKey: 's', strategy: 'obv_compound' });
  assert(r.ok, 'engine start failed: ' + r.error);
  engine.stopLoops(); // the sim drives every loop manually & deterministically
  assert.strictEqual(engine.season.startBalance, 32.50, 'season start balance = CURRENT balance');

  /* 1. open a position through the real pipeline */
  const aiRes = { score: 88, direction: 'LONG', confirmations: 9, classification: { label: 'Strong', action: '', cls: 'strong' }, breakdown: {}, tradable: true, reasons: [], notes: [] };
  const open = await engine.openPosition('TEST_USDT', 'LONG', aiRes, { side: 'LONG', entryPrice: 100, reason: 'sim', confluence: 8, initSl: 97 });
  assert(open.ok, 'open failed: ' + open.error);
  assert(engine.positions.has('TEST_USDT'), 'position registered');
  const pos = engine.positions.get('TEST_USDT');
  assert.strictEqual(pos.entryPrice, 100, 'entry reconciled from exchange');
  assert.strictEqual(pos.aiScore, 88, 'AI score attached to position');
  assert.strictEqual(pos.margin, 2, 'margin = baseMargin $2');
  assert.strictEqual(pos.slPrice, 97, 'exchange SL attached at -30% ROI @10x');

  /* 2. price rises past TP ROI -> trail arms (no hard close); rides peak; 0.5% pullback exits */
  stub.price = 103.2; // +32% ROI — past TP 30%: trail must ARM, not hard-close
  engine.managePosition(pos, Date.now());
  assert.ok(pos.trail.active, 'trail armed after TP ROI reached');
  assert(engine.positions.has('TEST_USDT'), 'no hard TP close — trail rides');
  const stop1 = pos.trail.stop;
  stub.price = 105; engine.managePosition(pos, Date.now());
  assert.ok(pos.trail.stop > stop1, 'trail ratchets');
  const peak = pos.trail.stop;
  stub.price = peak * 0.9985; engine.managePosition(pos, Date.now());
  await engine.reconcile(); // close order settles on the exchange
  assert(!engine.positions.has('TEST_USDT'), 'trail exit removed position');
  assert.strictEqual(engine.completed.length, 1, 'exactly 1 completed trade');
  const t1 = engine.completed[0];
  assert.ok(t1.pnl > 0.5, 'trail locked profit, pnl=' + t1.pnl);
  assert.ok(engine.baseMargin > 2, 'compounding increased margin: ' + engine.baseMargin);
  assert.strictEqual(engine.stats.executedTotal, 1, 'executedTotal exact');

  /* 3. loss path: baseMargin decreases, cooldown + consecutive losses */
  const before = engine.baseMargin;
  await engine.openPosition('TEST_USDT', 'LONG', aiRes, { side: 'LONG', entryPrice: stub.price, reason: 'sim2', confluence: 8, initSl: stub.price * 0.99 });
  const pos2 = engine.positions.get('TEST_USDT');
  stub.price = pos2.entryPrice * 0.965; // -35% ROI -> soft SL
  engine.managePosition(pos2, Date.now());
  await engine.reconcile();
  assert(!engine.positions.has('TEST_USDT'), 'SL exit');
  assert(engine.baseMargin < before, 'compounding decreased margin after loss');
  assert.ok(engine.cooldownUntil > Date.now(), 'anti-revenge cooldown set');
  assert.strictEqual(engine.stats.consecutiveLosses, 1, 'consecutive loss counted');

  /* 4. manual close detection via reconciliation */
  engine.cooldownUntil = 0; // clear cooldown for the test
  await engine.openPosition('TEST_USDT', 'LONG', aiRes, { side: 'LONG', entryPrice: stub.price, reason: 'sim3', confluence: 8, initSl: stub.price * 0.97 });
  assert(engine.positions.has('TEST_USDT'), 'third position open');
  const pos3 = engine.positions.get('TEST_USDT');
  stub.price = stub.price * 1.02; // user closes manually on MEXC app at +20% ROI
  engine.managePosition(pos3, Date.now()); // tick() keeps ROI fresh in production
  stub.open.delete('TEST_USDT');
  await engine.reconcile();
  assert(!engine.positions.has('TEST_USDT'), 'manual close removed from active positions');
  assert.strictEqual(engine.completed.length, 3, 'manual close recorded as completed');
  assert.strictEqual(engine.completed[2].exitType, 'MANUAL', 'exit type MANUAL');
  assert.strictEqual(engine.stats.executedTotal, 3, 'exact trade count after manual close');

  /* 5. risk halt after 3 consecutive losses */
  engine.stats.consecutiveLosses = 3;
  const pos4rec = { id: 99, symbol: 'T2_USDT', side: 'LONG', strategy: 'obv_compound', margin: 2, im: 2, leverage: 10, vol: 1, entryPrice: 100, openTime: Date.now(), aiScore: 80 };
  engine.positions.set('T2_USDT', pos4rec);
  engine.finalizeClose(pos4rec, 97, 'SL', 'sim -30% ROI');
  assert(engine.halted, 'risk halt engaged after 3 consecutive losses');

  /* 4b. AUDIT FIX: untracked exchange positions get adopted (restart survival) */
  stub.open.set('ADOPT_USDT', { positionId: 777, positionType: 2, state: 1, holdVol: 5, holdAvgPrice: 50, im: 1, leverage: 10 });
  await engine.reconcile();
  assert(engine.positions.has('ADOPT_USDT'), 'position adopted after appearing on exchange');
  const adopted = engine.positions.get('ADOPT_USDT');
  assert.strictEqual(adopted.adopted, true, 'adopted flag set');
  assert.strictEqual(adopted.side, 'SHORT', 'side derived from positionType');
  assert.strictEqual(adopted.entryPrice, 50, 'entry from exchange holdAvgPrice');
  stub.open.delete('ADOPT_USDT');
  await engine.reconcile();
  assert(!engine.positions.has('ADOPT_USDT'), 'adopted position closes cleanly');

  /* 5b. AUDIT FIX: stop(closePositions=true) records every closed trade */
  const beforeStop = engine.completed.length;
  await engine.openPosition('TEST_USDT', 'LONG', aiRes, { side: 'LONG', entryPrice: stub.price, reason: 'sim5', confluence: 8, initSl: stub.price * 0.97 });
  assert(engine.positions.has('TEST_USDT'), 'fifth position open for stop test');
  const stopRes = await engine.stop(true);
  assert(stopRes.ok, 'stop ok');
  assert.strictEqual(engine.completed.length, beforeStop + 1, 'stop(close) recorded the trade — got ' + engine.completed.length + ' vs ' + beforeStop);
  assert(engine.sessions.length >= 1, 'season archived on stop');
  assert(!engine.running, 'engine stopped');

  /* 6. dashboard snapshot integrity */
  const dash = engine.dashboard();
  assert.strictEqual(dash.stats.executedTotal, 6); // 4 pipeline + adopted close + stop close
  assert.strictEqual(dash.positions.length, 0);
  assert(dash.completed.length >= 6);
  assert(dash.feed.some((f) => f.type === 'trade_win'), 'robot got win event');
  assert(dash.feed.some((f) => f.type === 'trade_loss'), 'robot got loss event');

  await engine.stop(false);
  console.log('');
  console.log('ENGINE SIM: ALL PIPELINE CHECKS PASSED ✔');
  console.log(`  trades executed : ${dash.stats.executedTotal} (exact)`);
  console.log(`  base margin     : $2.00 → $${engine.baseMargin.toFixed(2)} (compounding works)`);
  console.log(`  season start    : $32.50 (current balance rule)`);
  process.exit(0);
})().catch((e) => { console.error('SIM FAIL:', e); process.exit(1); });
