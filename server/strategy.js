'use strict';
/* Strategy engine.
 * MODE obv_compound (Phase 1/5): OBV x EMA50 cross on 15m closed candles.
 *   BUY  when OBV crosses EMA50(OBV) upward, SELL when crosses downward.
 *   Requires |15m move| >= min15mMove % (Phase 5 filter), AI score gate, TP/SL ROI symmetric.
 * MODE scalp_3m (Phase 6): EMA9/EMA21 trend + RSI14 + volume spike + 15m HTF filter,
 *   structure SL, TP1 15% ROI (close 50%, SL->BE, trail EMA21), TP2 30% ROI, exit engine, confluence >= 7.
 * NOTE: MEXC has no native 3m kline interval -> 3m candles are aggregated from 1m klines. */
const ind = require('./indicators');

/* ---------- price math (ROI-based) ---------- */
function roiToPrice(entry, leverage, roiPct, dirLong) {
  const move = roiPct / 100 / leverage;
  return dirLong ? entry * (1 + move) : entry * (1 - move);
}
/* STOP price for a stop-loss ROI: always on the LOSS side of the direction */
function stopPrice(entry, leverage, roiPct, isLong) {
  return roiToPrice(entry, leverage, roiPct, !isLong);
}
function priceToRoi(entry, price, leverage, dirLong) {
  if (!entry || !price) return 0;
  const raw = (price - entry) / entry * leverage * 100;
  return dirLong ? raw : -raw;
}
function pnlUsd(margin, roiPct) { return margin * roiPct / 100; }

/* ---------- OBV x EMA50 cross (evaluated on CLOSED candles only) ---------- */
function obvCrossSignal(k15mClosed) {
  if (!k15mClosed || k15mClosed.length < 60) return { signal: null, reason: 'warming up OBV (need 60+ 15m candles)' };
  const obvArr = ind.obv(k15mClosed);
  const emaArr = ind.ema(obvArr, 50);
  const i = obvArr.length - 1;
  const obvPrev = obvArr[i - 1], emaPrev = emaArr[i - 1];
  const obvNow = obvArr[i], emaNow = emaArr[i];
  if (obvPrev == null || emaPrev == null || obvNow == null || emaNow == null) return { signal: null, reason: 'OBV EMA not ready' };
  const crossUp = obvPrev <= emaPrev && obvNow > emaNow;
  const crossDown = obvPrev >= emaPrev && obvNow < emaNow;
  if (crossUp) return { signal: 'BUY', obv: obvNow, ema: emaNow, candle: k15mClosed[i] };
  if (crossDown) return { signal: 'SELL', obv: obvNow, ema: emaNow, candle: k15mClosed[i] };
  return { signal: null, obv: obvNow, ema: emaNow };
}

/* 15m move over the last ~15–30 minutes (uses closed 15m candles: last close vs close 2 candles back) */
function move15to30(k15mClosed) {
  if (!k15mClosed || k15mClosed.length < 3) return 0;
  const a = k15mClosed[k15mClosed.length - 3].close;
  const b = ind.last(k15mClosed).close;
  return a > 0 ? Math.abs(b - a) / a * 100 : 0;
}

/* ---------- Phase 6 market pre-filter (ALL must pass) ---------- */
function marketFilter(ctx) {
  const { k3mClosed, k15mClosed, ticker, minMovePct, minVolSpike } = ctx;
  const out = { ok: false, checks: {} };
  const move = move15to30(k15mClosed);
  out.checks.move = { value: round2(move), need: '>=' + minMovePct + '%', pass: move >= minMovePct };
  const spike = ind.volumeSpike(k3mClosed, 5);
  out.checks.volSpike = { value: round2(spike) + 'x', need: '>=' + minVolSpike + 'x', pass: spike >= minVolSpike };
  let spreadPct = 0;
  if (ticker && ticker.bid1 && ticker.ask1 && ticker.lastPrice) {
    spreadPct = (ticker.ask1 - ticker.bid1) / ticker.lastPrice * 100;
  }
  out.checks.spread = { value: round2(spreadPct) + '%', need: '<0.15%', pass: spreadPct < 0.15 };
  const w = ind.wick(ind.last(k3mClosed));
  const wickOk = w.upperWickPct < 65 && w.lowerWickPct < 65;
  out.checks.wick = { value: round2(Math.max(w.upperWickPct, w.lowerWickPct)) + '%', need: '<65%', pass: wickOk };
  const atrArr = ind.atr(k3mClosed, 14);
  const a = ind.last(atrArr);
  const px = ind.last(k3mClosed).close;
  const atrPct = a && px ? a / px * 100 : 0;
  const active = atrPct >= 0.10 && atrPct <= 2.5;
  out.checks.active = { value: round2(atrPct) + '% ATR', need: '0.10–2.5%', pass: active };
  out.ok = out.checks.move.pass && out.checks.volSpike.pass && out.checks.spread.pass && out.checks.wick.pass && out.checks.active.pass;
  return out;
}

/* ---------- Phase 6 entry (evaluated at 3m candle close) ---------- */
function scalpSignal(ctx) {
  /* ctx: {k3mClosed, k15mClosed, ticker, minMovePct, minVolSpike, lev} */
  const { k3mClosed, k15mClosed, ticker, minMovePct, minVolSpike } = ctx;
  if (k3mClosed.length < 40 || k15mClosed.length < 30) return { signal: null, reason: 'warming up (need 40+ 3m / 30+ 15m candles)' };
  const mf = marketFilter({ k3mClosed, k15mClosed, ticker, minMovePct, minVolSpike });
  if (!mf.ok) return { signal: null, reason: 'market filter: ' + failedName(mf.checks), filter: mf };

  const closes3 = k3mClosed.map((c) => c.close);
  const e9 = ind.ema(closes3, 9), e21 = ind.ema(closes3, 21);
  const i = closes3.length - 1;
  const c = k3mClosed[i], cPrev = k3mClosed[i - 1];

  /* 15m higher-timeframe trend */
  const closes15 = k15mClosed.map((x) => x.close);
  const e9_15 = ind.ema(closes15, 9), e21_15 = ind.ema(closes15, 21);
  const htfBull = ind.last(e9_15) > ind.last(e21_15) && ind.last(closes15) > ind.last(e21_15);
  const htfBear = ind.last(e9_15) < ind.last(e21_15) && ind.last(closes15) < ind.last(e21_15);

  const trend3Bull = ind.last(e9) > ind.last(e21);
  const trend3Bear = ind.last(e9) < ind.last(e21);

  /* RSI cross */
  const r14 = ind.rsi(closes3, 14);
  const rPrev = r14[i - 1] || 50, rNow = r14[i] || 50;
  const rsiCrossUp = rPrev <= 50 && rNow > 50;
  const rsiCrossDown = rPrev >= 50 && rNow < 50;

  /* volume spike */
  const spike = ind.volumeSpike(k3mClosed, 5);

  /* structure */
  const st15 = ind.structure(k15mClosed.slice(-60), 2, 3);
  const st3 = ind.structure(k3mClosed.slice(-40), 2, 3);

  /* volatility active */
  const atrArr = ind.atr(k3mClosed, 14);
  const atrPct = (ind.last(atrArr) || 0) / c.close * 100;
  const vol = spike >= ctx.minVolSpike;

  /* retrace touch within last 3 candles (long: low touched EMA9/21) */
  let touchedLong = false, touchedShort = false;
  for (let j = Math.max(1, i - 2); j <= i; j++) {
    if (k3mClosed[j].low <= e9[j] || k3mClosed[j].low <= e21[j]) touchedLong = true;
    if (k3mClosed[j].high >= e9[j] || k3mClosed[j].high >= e21[j]) touchedShort = true;
  }

  const bullCandle = c.close > c.open && c.close > e9[i];
  const bearCandle = c.close < c.open && c.close < e9[i];

  /* confluence score /10: trend 2, volume 2, structure 2, rsi 1, volatility 2, momentum 1 */
  const cfBull = [
    trend3Bull && htfBull ? 2 : 0,
    vol ? 2 : 0,
    (st15 === 'HH_HL' || st3 === 'HH_HL') ? 2 : 0,
    rsiCrossUp && rNow > 50 ? 1 : 0,
    atrPct >= 0.10 && atrPct <= 2.5 ? 2 : 0,
    c.close > ind.last(e21) ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
  const cfBear = [
    trend3Bear && htfBear ? 2 : 0,
    vol ? 2 : 0,
    (st15 === 'LH_LL' || st3 === 'LH_LL') ? 2 : 0,
    rsiCrossDown && rNow < 50 ? 1 : 0,
    atrPct >= 0.10 && atrPct <= 2.5 ? 2 : 0,
    c.close < ind.last(e21) ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const longOk = trend3Bull && htfBull && touchedLong && bullCandle && rsiCrossUp;
  const shortOk = trend3Bear && htfBear && touchedShort && bearCandle && rsiCrossDown;

  if (longOk && cfBull >= 7) {
    return { signal: 'BUY', entryCandle: c, entryPrice: c.close, confluence: cfBull, rsi: rNow, spike, sl: scalpStop(k3mClosed, 'LONG'), reason: '3M scalping LONG confluence ' + cfBull + '/10', filter: mf };
  }
  if (shortOk && cfBear >= 7) {
    return { signal: 'SELL', entryCandle: c, entryPrice: c.close, confluence: cfBear, rsi: rNow, spike, sl: scalpStop(k3mClosed, 'SHORT'), reason: '3M scalping SHORT confluence ' + cfBear + '/10', filter: mf };
  }
  const why = [];
  if (trend3Bull !== htfBull || trend3Bear !== htfBear) why.push('TF mismatch');
  if (!touchedLong && !touchedShort) why.push('no EMA retrace');
  if (!rsiCrossUp && !rsiCrossDown) why.push('no RSI50 cross');
  if (!bullCandle && !bearCandle) why.push('no confirmation candle');
  if (Math.max(cfBull, cfBear) < 7) why.push('confluence ' + Math.max(cfBull, cfBear) + '/10 < 7');
  return { signal: null, reason: why.join(', ') || 'conditions not met', confluence: Math.max(cfBull, cfBear), filter: mf };
}

function failedName(checks) {
  return Object.keys(checks).filter((k) => !checks[k].pass).join(', ');
}

/* structure-based stop: recent swing low (long) / swing high (short) over last 10 closed candles */
function scalpStop(k3mClosed, side) {
  const win = k3mClosed.slice(-10);
  let price;
  if (side === 'LONG') {
    price = Math.min(...win.map((c) => c.low)) * 0.9995;
  } else {
    price = Math.max(...win.map((c) => c.high)) * 1.0005;
  }
  return { type: 'structure', price };
}
function cappedStop(slPrice, entry, leverage, maxLossRoi, side) {
  const isLong = side === 'LONG';
  /* loss cap for a LONG sits BELOW entry; for a SHORT ABOVE entry */
  const cap = roiToPrice(entry, leverage, maxLossRoi, !isLong);
  return isLong ? Math.max(slPrice, cap) : Math.min(slPrice, cap);
}

/* ---------- Exit engine (Phase 6 section 8) — evaluated on closed 3m candles ---------- */
function scalpExit(ctx) {
  /* ctx: {side:'LONG'|'SHORT', k3mClosed, openedAt, entryPrice, leverage, inProfit, maxHoldMin} */
  const { side, k3mClosed, openedAt, entryPrice, leverage, inProfit } = ctx;
  const closes = k3mClosed.map((c) => c.close);
  if (closes.length < 30) return null;
  const e9 = ind.ema(closes, 9), e21 = ind.ema(closes, 21);
  const i = closes.length - 1;
  const long = side === 'LONG';

  // 1) EMA9 crossed opposite EMA21 on the last closed candle
  const crossOpp = long
    ? (e9[i - 1] >= e21[i - 1] && e9[i] < e21[i])
    : (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i]);
  if (crossOpp) return { exit: true, reason: 'EMA9 crossed ' + (long ? 'below' : 'above') + ' EMA21' };

  // 2) RSI fails to hold the 50 zone after entry
  const r = ind.rsi(closes, 14);
  const rNow = r[i] || 50;
  if (long && rNow < 45) return { exit: true, reason: 'RSI lost the 50 zone (' + Math.round(rNow) + ')' };
  if (!long && rNow > 55) return { exit: true, reason: 'RSI lost the 50 zone (' + Math.round(rNow) + ')' };

  // 3) Volume drops below 5-candle average while not in profit
  const spike = ind.volumeSpike(k3mClosed, 5);
  if (spike < 1 && !inProfit) return { exit: true, reason: 'Volume collapsed below 5-candle avg while not in profit' };

  // 4) Timeout: not in profit after 6 candles (18 min on 3m)
  const holdMin = (Date.now() - openedAt) / 60000;
  if (holdMin >= (ctx.maxHoldMin || 18) && !inProfit) return { exit: true, reason: 'Timeout: no profit after ' + Math.round(holdMin) + ' min' };

  return null;
}

/* ---------- OBV-mode trailing stop (after TP ROI trigger, trail by % distance) ---------- */
function trailUpdate(trail, price, dirLong, triggerRoi, curRoi, distPct) {
  /* trail: {active, peak, stop} ; returns updated trail */
  const t = Object.assign({}, trail);
  if (!t.active && curRoi >= triggerRoi) { t.active = true; t.peak = price; t.stop = dirLong ? price * (1 - distPct / 100) : price * (1 + distPct / 100); }
  else if (t.active) {
    if (dirLong && price > t.peak) { t.peak = price; t.stop = Math.max(t.stop || 0, price * (1 - distPct / 100)); }
    if (!dirLong && (price < t.peak || !t.peak)) { t.peak = price; t.stop = Math.min(t.stop || Infinity, price * (1 + distPct / 100)); }
  }
  return t;
}
function trailHit(trail, price, dirLong) {
  return trail.active && trail.stop != null && (dirLong ? price <= trail.stop : price >= trail.stop);
}

/* ---------- scalp EMA21 trail (after TP1) ---------- */
function scalpTrailStop(side, ema21Now, breakeven, prevStop) {
  let s = side === 'LONG' ? Math.max(breakeven, ema21Now) : Math.min(breakeven, ema21Now);
  if (prevStop != null) {
    s = side === 'LONG' ? Math.max(s, prevStop) : Math.min(s, prevStop); // ratchet
  }
  return s;
}

function round2(v) { return Math.round(v * 100) / 100; }

module.exports = {
  roiToPrice, stopPrice, priceToRoi, pnlUsd,
  obvCrossSignal, move15to30, marketFilter, scalpSignal,
  scalpStop, cappedStop, scalpExit,
  trailUpdate, trailHit, scalpTrailStop,
};
