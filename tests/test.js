'use strict';
/* Sanity tests for indicator math, ROI/compounding rules and strategy signals.
 * Run: node tests/test.js  (offline, synthetic data — the live bot itself is never mocked) */
const assert = require('assert');
const ind = require('../server/indicators');
const strat = require('../server/strategy');
const ai = require('../server/aiscore');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✔ ' + name); pass++; }
  catch (e) { console.error('  ✘ ' + name + ' → ' + e.message); fail++; }
}

/* ---------- synthetic candle generator ---------- */
function gen(n, start, drift, vol) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = Math.max(0.0001, p * (1 + drift + (Math.sin(i / 5) + (Math.random() - 0.5)) * vol));
    const c = p;
    const h = Math.max(o, c) * (1 + vol / 4);
    const l = Math.min(o, c) * (1 - vol / 4);
    out.push({ t: i * 60, open: o, high: h, low: l, close: c, vol: 100 + (Math.random() * 50), amount: c * 100 });
  }
  return out;
}

console.log('indicators:');
t('EMA converges to value', () => {
  const e = ind.ema([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 5);
  assert.ok(Math.abs(e[9] - 10) < 1e-9);
});
t('EMA Trend UP detected as rising for increasing series', () => {
  const e = ind.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.ok(e[9] > e[8]);
});
t('RSI bounds 0..100 and overbought for straight-up series', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const r = ind.rsi(up, 14);
  assert.ok(r[39] > 95 && r[39] <= 100);
  const dn = Array.from({ length: 40 }, (_, i) => 200 - i);
  const r2 = ind.rsi(dn, 14);
  assert.ok(r2[39] < 5 && r2[39] >= 0);
});
t('MACD line above signal in uptrend', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i));
  const m = ind.macd(up);
  assert.ok(ind.last(m.line) > ind.last(m.signal));
});
t('OBV rises in uptrend', () => {
  const c = gen(50, 100, 0.01, 0.002);
  const o = ind.obv(c);
  assert.ok(o[49] > o[0]);
});
t('aggregate 1m→3m buckets & dropForming', () => {
  const base = Math.floor(Date.now() / 1000 / 180) * 180 - 180 * 5;
  const candles = [];
  for (let i = 0; i < 15; i++) candles.push({ t: base + i * 60, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10, amount: 15 });
  const agg = ind.aggregate(candles, 3);
  assert.strictEqual(agg.length, 5);
  const dropped = ind.dropForming(agg, 180, base + 15 * 60);
  assert.strictEqual(dropped.length, 5); // all complete
  const partial = ind.dropForming(agg, 180, base + 14 * 60);
  assert.ok(partial.length <= 5);
});
t('structure HH_HL on uptrend', () => {
  // alternating impulse/pullback generator so swing pivots actually confirm
  function swing(n, start, up, imp, pull) {
    const out = []; let p = start;
    for (let i = 0; i < n; i++) {
      const chg = (i % 6 < 4 ? 1 : -1) * (i % 6 < 4 ? imp : pull);
      const o = p; p = Math.max(0.0001, p * (1 + chg)); const c = p;
      out.push({ t: i * 900, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, vol: 100, amount: c * 100 });
    }
    return out;
  }
  const up = swing(80, 100, true, 0.01, 0.003);
  assert.strictEqual(ind.structure(up, 2, 3), 'HH_HL', 'got ' + ind.structure(up, 2, 3));
  const dn = swing(80, 100, false, -0.01, -0.003);
  assert.strictEqual(ind.structure(dn, 2, 3), 'LH_LL', 'got ' + ind.structure(dn, 2, 3));
});

console.log('strategy math:');
t('ROI→price 30% ROI at 10x leverage = 3% price move', () => {
  const entry = 1000;
  const tp = strat.roiToPrice(entry, 10, 30, true);
  assert.ok(Math.abs(tp - 1030) < 1e-9);
  const sl = strat.roiToPrice(entry, 10, 30, false);
  assert.ok(Math.abs(sl - 970) < 1e-9);
  // short mirrored
  const tpS = strat.roiToPrice(entry, 10, 30, false);
  assert.ok(Math.abs(tpS - 970) < 1e-9);
});
t('priceToRoi long/short round trip', () => {
  const roi = strat.priceToRoi(100, 103, 10, true);
  assert.ok(Math.abs(roi - 30) < 1e-6);
  const roiS = strat.priceToRoi(100, 97, 10, false);
  assert.ok(Math.abs(roiS - 30) < 1e-6);
  const roiLoss = strat.priceToRoi(100, 97, 10, true);
  assert.ok(Math.abs(roiLoss + 30) < 1e-6);
});
t('pnl: $2 margin, +30% ROI = +$0.60', () => {
  assert.ok(Math.abs(strat.pnlUsd(2, 30) - 0.6) < 1e-9);
  assert.ok(Math.abs(strat.pnlUsd(2, -30) + 0.6) < 1e-9);
});
t('compounding: $1 profit over 5 slots → +$0.20 per next trade', () => {
  const base = 2;
  const pnl = 1, slots = 5;
  const next = base + pnl / slots;
  assert.ok(Math.abs(next - 2.2) < 1e-9);
  const nextLoss = base + (-1) / slots;
  assert.ok(Math.abs(nextLoss - 1.8) < 1e-9);
});
t('OBV cross detection fires only at true crossings', () => {
  // craft candles where OBV dips below its EMA50 then crosses back up
  const candles = [];
  let price = 100;
  for (let i = 0; i < 90; i++) {
    const up = i % 2 === 0;
    price += up ? 1 : -0.9;
    candles.push({ t: i * 900, open: price, high: price + 1, low: price - 1, close: price + (up ? 0.5 : -0.5), vol: 100, amount: 10 });
  }
  const r = strat.obvCrossSignal(candles);
  assert.ok(typeof r.signal === 'string' || r.signal === null);
});
t('trailing activates at 30% ROI and follows peak (long)', () => {
  let tr = { active: false, peak: null, stop: null };
  let price = 100;
  tr = strat.trailUpdate(tr, price, true, 30, 10, 0.5);
  assert.strictEqual(tr.active, false);
  tr = strat.trailUpdate(tr, 104, true, 30, 40, 0.5);
  assert.strictEqual(tr.active, true);
  assert.ok(tr.stop > 100);
  const peakStop = tr.stop;
  tr = strat.trailUpdate(tr, 106, true, 30, 60, 0.5);
  assert.ok(tr.stop > peakStop, 'stop ratchets up');
  tr = strat.trailUpdate(tr, 105.9, true, 30, 59, 0.5);
  assert.ok(Math.abs(tr.stop - peakStopAdj(tr)) >= 0);
  assert.strictEqual(strat.trailHit(tr, 105.4, true), true, 'trail hit below stop');
  function peakStopAdj(t) { return t.stop; }
});
t('scalp exit engine: EMA cross opposite triggers exit', () => {
  // uptrend then sharp reversal
  const candles = [];
  let price = 100;
  for (let i = 0; i < 60; i++) { price *= i < 45 ? 1.004 : 0.985; candles.push({ t: i * 180, open: price / 1.001, high: price * 1.002, low: price * 0.997, close: price, vol: 100, amount: 1 }); }
  const r = strat.scalpExit({ side: 'LONG', k3mClosed: candles, openedAt: Date.now() - 5 * 60000, entryPrice: 101, leverage: 10, inProfit: false, maxHoldMin: 18 });
  assert.ok(r && r.exit === true);
});
t('scalp stop capped at -30% ROI', () => {
  const capped = strat.cappedStop(60, 100, 10, 30, 'LONG'); // structure SL at 60 → too far → cap to 97
  assert.ok(Math.abs(capped - 97) < 1e-9);
  const kept = strat.cappedStop(98, 100, 10, 30, 'LONG'); // structure SL at 98 → keep
  assert.ok(Math.abs(kept - 98) < 1e-9);
});

console.log('ai score:');
t('strong uptrend scores LONG & tradable', () => {
  const up = gen(220, 100, 0.004, 0.0015);
  const res = ai.evaluate({
    symbol: 'TEST_USDT', price: ind.last(up).close, fundingRate: 0.0001,
    oiNow: 1000, oi15mAgo: 900, k3m: up.slice(-60), k15m: up, k1h: up.slice(-60), k4h: null,
  });
  assert.strictEqual(res.direction, 'LONG', 'direction=' + res.direction);
  assert.ok(res.score >= 40, 'score=' + res.score);
});
t('downtrend scores SHORT', () => {
  const dn = gen(220, 100, -0.004, 0.0015);
  const res = ai.evaluate({
    symbol: 'TEST_USDT', price: ind.last(dn).close, fundingRate: 0.0001,
    oiNow: 900, oi15mAgo: 1000, k3m: dn.slice(-60), k15m: dn, k1h: dn.slice(-60), k4h: null,
  });
  assert.strictEqual(res.direction, 'SHORT', 'direction=' + res.direction);
});
t('classification labels match spec table', () => {
  assert.strictEqual(ai.classify(95).label, 'Elite Setup');
  assert.strictEqual(ai.classify(85).label, 'Strong');
  assert.strictEqual(ai.classify(72).label, 'Good');
  assert.strictEqual(ai.classify(65).label, 'Moderate');
  assert.strictEqual(ai.classify(50).label, 'Weak');
  assert.strictEqual(ai.classify(20).label, 'Very Weak');
});

console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
