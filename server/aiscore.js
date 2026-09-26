'use strict';
/* AI Trading Score System (0–100) — Phase 2 model.
 * 10 indicators, weighted: Trend 15, Volume 15, Structure 15, Multi-Timeframe 15,
 * RSI 10, MACD 10, Support/Resistance 10, ATR 5, Open Interest 3, Funding 2. Total 100.
 * Classification: 0-39 Very Weak, 40-59 Weak, 60-69 Moderate, 70-79 Good,
 *                 80-89 Strong, 90-100 Elite. Trade threshold 70 & >=7 confirmations. */
const ind = require('./indicators');

const WEIGHTS = { trend: 15, volume: 15, structure: 15, mtf: 15, rsi: 10, macd: 10, sr: 10, atr: 5, oi: 3, funding: 2 };

function classify(score) {
  if (score >= 90) return { label: 'Elite Setup', action: 'Aggressive Opportunity', cls: 'elite' };
  if (score >= 80) return { label: 'Strong', action: 'High Probability Trade', cls: 'strong' };
  if (score >= 70) return { label: 'Good', action: 'Tradeable', cls: 'good' };
  if (score >= 60) return { label: 'Moderate', action: 'Risky Setup', cls: 'moderate' };
  if (score >= 40) return { label: 'Weak', action: 'Watchlist Only', cls: 'weak' };
  return { label: 'Very Weak', action: 'Avoid Trading', cls: 'veryweak' };
}

function safeTail(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

/* Full AI evaluation. bundle = {
 *   symbol, price, fundingRate, oiNow, oi15mAgo,
 *   k3m: closed 3m candles, k15m, k1h, k4h  (closed candle arrays)
 * } */
function evaluate(bundle) {
  const { symbol, price, fundingRate, oiNow, oi15mAgo, k3m, k15m, k1h, k4h } = bundle;
  const notes = [];
  if (!k15m || k15m.length < 30 || !k3m || k3m.length < 30) {
    return { symbol, score: 0, direction: 'NEUTRAL', confirmations: 0, classification: classify(0), breakdown: zeroBreakdown(), tradable: false, reasons: ['Not enough market data yet'], notes };
  }
  const px = price || ind.last(k3m).close;

  /* ---- 1. Trend (15) on 15m: price vs EMA50, EMA50 vs EMA200 ---- */
  const c15 = safeTail(k15m, 260).map((c) => c.close);
  const e50 = ind.ema(c15, 50), e200 = ind.ema(c15, 200);
  const p50 = e50[e50.length - 1], p200 = e200[e200.length - 1];
  let trendBull = 0, trendBear = 0;
  if (p50 != null && p200 != null) {
    const above = px > p50, golden = p50 > p200;
    const below = px < p50, death = p50 < p200;
    trendBull = (above && golden) ? 15 : (above || golden) ? 8 : 0;
    trendBear = (below && death) ? 15 : (below || death) ? 8 : 0;
  }
  if (p200 == null) notes.push('EMA200 warming up on 15m');

  /* ---- 2. Volume (15): participation + OBV slope on 3m ---- */
  const vols3 = k3m.map((c) => c.vol);
  const volAvg20 = ind.sma(vols3, 20);
  const va = volAvg20[volAvg20.length - 1];
  const curVol = ind.last(k3m).vol;
  const spike = va > 0 ? curVol / va : 0;
  let volBase = spike >= 1.5 ? 15 : spike >= 1.1 ? 11 : spike >= 0.85 ? 7 : spike >= 0.6 ? 3 : 0;
  const obvArr = ind.obv(safeTail(k3m, 60));
  const obvSlope = obvArr[obvArr.length - 1] - obvArr[Math.max(0, obvArr.length - 6)];
  const volBull = obvSlope > 0 ? volBase : Math.round(volBase * 0.5);
  const volBear = obvSlope < 0 ? volBase : Math.round(volBase * 0.5);

  /* ---- 3. Structure (15): HH+HL vs LH+LL ---- */
  const st = ind.structure(safeTail(k15m, 90), 2, 4);
  const stBull = st === 'HH_HL' ? 15 : st === 'MIXED' ? 4 : 0;
  const stBear = st === 'LH_LL' ? 15 : st === 'MIXED' ? 4 : 0;

  /* ---- 4. Multi-timeframe (15): 3m, 15m, 1h, 4h alignment ----
   * AUDIT FIX: timeframes with missing data are SKIPPED (neutral) — they used to be
   * counted as bearish, which biased every symbol without long history against LONGs. */
  const c3 = safeTail(k3m, 60).map((c) => c.close);
  const e9_3 = ind.ema(c3, 9), e21_3 = ind.ema(c3, 21);
  let bullCount = 0, bearCount = 0, tfCounted = 0;
  if (ind.last(e9_3) != null && ind.last(e21_3) != null) {
    if (ind.last(e9_3) > ind.last(e21_3)) bullCount++; else bearCount++;
    tfCounted++;
  }
  const c15tf = safeTail(k15m, 60).map((c) => c.close);
  const e9_15 = ind.ema(c15tf, 9), e21_15 = ind.ema(c15tf, 21);
  if (ind.last(e9_15) != null && ind.last(e21_15) != null) {
    if (ind.last(e9_15) > ind.last(e21_15)) bullCount++; else bearCount++;
    tfCounted++;
  }
  const c1h = k1h && k1h.length >= 55 ? safeTail(k1h, 60).map((c) => c.close) : null;
  if (c1h) {
    const e50_1h = ind.ema(c1h, 50);
    if (ind.last(e50_1h) != null) {
      if (ind.last(c1h) > ind.last(e50_1h)) bullCount++; else bearCount++;
      tfCounted++;
    }
  }
  const c4h = k4h && k4h.length >= 55 ? safeTail(k4h, 60).map((c) => c.close) : null;
  if (c4h) {
    const e50_4h = ind.ema(c4h, 50);
    if (ind.last(e50_4h) != null) {
      if (ind.last(c4h) > ind.last(e50_4h)) bullCount++; else bearCount++;
      tfCounted++;
    }
  }
  const rBull = tfCounted ? bullCount / tfCounted : 0;
  const rBear = tfCounted ? bearCount / tfCounted : 0;
  const mtfBull = rBull === 1 ? 15 : rBull >= 0.75 ? 11 : rBull >= 0.5 ? 7 : rBull >= 0.25 ? 3 : 0;
  const mtfBear = rBear === 1 ? 15 : rBear >= 0.75 ? 11 : rBear >= 0.5 ? 7 : rBear >= 0.25 ? 3 : 0;

  /* ---- 5. RSI (10) on 3m ---- */
  const r14 = ind.rsi(c3, 14);
  const r = ind.last(r14) || 50;
  let rsiBull = 0, rsiBear = 0;
  if (r >= 55 && r <= 70) rsiBull = 10; else if (r > 50 && r < 55) rsiBull = 6; else if (r > 70 && r <= 80) rsiBull = 4; else if (r > 80) { rsiBull = 0; notes.push('RSI overbought >80'); }
  if (r >= 30 && r <= 45) rsiBear = 10; else if (r >= 45 && r < 50) rsiBear = 6; else if (r >= 20 && r < 30) rsiBear = 4; else if (r < 20) { rsiBear = 0; notes.push('RSI oversold <20'); }

  /* ---- 6. MACD (10) on 3m ---- */
  const m = ind.macd(c3);
  const line = ind.last(m.line), sig = ind.last(m.signal), hist = ind.last(m.hist);
  const histPrev = m.hist[m.hist.length - 2] || 0;
  const macdBull = line != null && sig != null && line > sig ? (hist > histPrev ? 10 : 6) : 0;
  const macdBear = line != null && sig != null && line < sig ? (hist < histPrev ? 10 : 6) : 0;

  /* ---- 7. Support/Resistance (10) on 15m ---- */
  const sr = srScore(safeTail(k15m, 70), px, notes);

  /* ---- 8. ATR (5) on 3m — healthy volatility band ---- */
  const atrArr = ind.atr(safeTail(k3m, 140), 14);
  const a = ind.last(atrArr);
  let atrPts = 0;
  if (a && px > 0) {
    const pct = a / px * 100;
    const hist = atrArr.filter((v) => v != null).slice(-100);
    const sorted = [...hist].sort((x, y) => x - y);
    const rank = sorted.length ? sorted.findIndex((v) => v >= a) / sorted.length * 100 : 50;
    if (pct >= 0.10 && pct <= 2.5 && rank >= 30 && rank <= 88) atrPts = 5;
    else if (rank >= 18 && rank <= 94) atrPts = 2;
    else atrPts = 0;
    if (atrPts === 0) notes.push('ATR out of healthy band');
  }
  const atrBoth = atrPts; // direction-neutral

  /* ---- 9. Open Interest (3) ---- */
  let oiBull = 1.5, oiBear = 1.5;
  if (oiNow != null && oi15mAgo != null && oi15mAgo > 0) {
    const oiChg = (oiNow - oi15mAgo) / oi15mAgo;
    const pxChg = px15mChange(k15m);
    if (oiChg > 0.002 && pxChg > 0.002) { oiBull = 3; oiBear = 0; }
    else if (oiChg > 0.002 && pxChg < -0.002) { oiBull = 0; oiBear = 3; }
    else if (oiChg < -0.002 && pxChg > 0.002) { oiBull = 1; oiBear = 0; }
    else if (oiChg < -0.002 && pxChg < -0.002) { oiBull = 0; oiBear = 1; }
  }

  /* ---- 10. Funding / Sentiment (2) ---- */
  const fr = Math.abs(fundingRate || 0);
  let fundPts = fr < 0.0004 ? 2 : fr < 0.001 ? 1 : 0;
  if (fundPts === 0) notes.push('Funding overheated (extreme)');
  const fundBoth = fundPts; // direction-neutral

  const B = {
    trend: { bull: trendBull, bear: trendBear, w: 15 },
    volume: { bull: volBull, bear: volBear, w: 15 },
    structure: { bull: stBull, bear: stBear, w: 15 },
    mtf: { bull: mtfBull, bear: mtfBear, w: 15 },
    rsi: { bull: rsiBull, bear: rsiBear, w: 10 },
    macd: { bull: macdBull, bear: macdBear, w: 10 },
    sr: { bull: sr.bull, bear: sr.bear, w: 10 },
    atr: { bull: atrBoth, bear: atrBoth, w: 5 },
    oi: { bull: oiBull, bear: oiBear, w: 3 },
    funding: { bull: fundBoth, bear: fundBoth, w: 2 },
  };

  const bull = Object.keys(B).reduce((s, k) => s + B[k].bull, 0);
  const bear = Object.keys(B).reduce((s, k) => s + B[k].bear, 0);
  let direction = 'NEUTRAL';
  let score = Math.max(bull, bear);
  if (bull > bear && bull >= 40) direction = 'LONG';
  else if (bear > bull && bear >= 40) direction = 'SHORT';
  if (bull === bear) { score = bull; }

  const half = {};
  for (const k of Object.keys(B)) half[k] = B[k].w / 2;
  let confirmations = 0;
  const side = direction === 'SHORT' ? 'bear' : 'bull';
  for (const k of Object.keys(B)) if (B[k][side] >= half[k]) confirmations++;

  const breakdown = {};
  for (const k of Object.keys(B)) breakdown[k] = Math.round(B[k][side] * 10) / 10;

  const reasons = [];
  let tradable = false;
  if (direction === 'NEUTRAL') reasons.push('Conflicting signals (no dominant side)');
  else {
    if (score < 70) reasons.push(`AI score ${score} < 70`);
    if (confirmations < 7) reasons.push(`Confirmations ${confirmations}/10 < 7`);
    if (B.trend[side] < 7.5) reasons.push('Trend not aligned');
    if (B.volume[side] < 7.5) reasons.push('Volume not confirmed');
    if (direction === 'LONG' && B.structure.bull < 7.5) reasons.push('Market structure not bullish');
    if (direction === 'SHORT' && B.structure.bear < 7.5) reasons.push('Market structure not bearish');
    tradable = reasons.length === 0;
  }

  return { symbol, score, bull, bear, direction, confirmations, classification: classify(score), breakdown, tradable, reasons, notes };
}

function srScore(k15m, px, notes) {
  const { highs, lows } = ind.pivots(k15m, 2);
  if (!highs.length || !lows.length) return { bull: 2, bear: 2 };
  const lastC = ind.last(k15m);
  const res = highs[highs.length - 1].price;
  const sup = lows[lows.length - 1].price;
  const brokeUp = lastC.close > res && lastC.close > lastC.open;
  const brokeDown = lastC.close < sup && lastC.close < lastC.open;
  // fake breakout: prior candle poked beyond but closed back inside
  const prev = k15m[k15m.length - 2];
  if (prev && prev.high > res && prev.close < res && lastC.close < res) notes.push('Fake breakout above resistance detected');
  if (prev && prev.low < sup && prev.close > sup && lastC.close > sup) notes.push('Fake breakdown below support detected');
  if (brokeUp) return { bull: 10, bear: 0 };
  if (brokeDown) return { bull: 0, bear: 10 };
  const nearSup = px <= sup * 1.012 && px >= sup * 0.995;
  const nearRes = px >= res * 0.988 && px <= res * 1.005;
  if (nearSup) return { bull: 8, bear: 0 };
  if (nearRes) return { bull: 0, bear: 8 };
  const mid = px > sup && px < res;
  if (mid) return { bull: 4, bear: 4 };
  return { bull: 2, bear: 2 };
}

function px15mChange(k15m) {
  if (k15m.length < 2) return 0;
  const a = k15m[k15m.length - 2].close, b = ind.last(k15m).close;
  return a > 0 ? (b - a) / a : 0;
}

function zeroBreakdown() {
  const z = {};
  for (const k of Object.keys(WEIGHTS)) z[k] = 0;
  return z;
}

/* Lightweight quick score for the market scanner (15m data only) */
function quickEvaluate(symbol, k15mClosed, ticker) {
  if (!k15mClosed || k15mClosed.length < 30) return { score: 0, direction: 'NEUTRAL' };
  const closes = k15mClosed.map((c) => c.close);
  const px = ind.last(closes);
  const e9 = ind.ema(closes, 9), e21 = ind.ema(closes, 21), e50 = ind.ema(closes, 50);
  let bull = 0, bear = 0;
  if (px > ind.last(e9) && ind.last(e9) > ind.last(e21)) bull += 4;
  if (px < ind.last(e9) && ind.last(e9) < ind.last(e21)) bear += 4;
  if (ind.last(e21) > ind.last(e50)) bull += 2; else bear += 2;
  const r = (ind.rsi(closes, 14) || [50]);
  const rv = r[r.length - 1] || 50;
  if (rv >= 55 && rv <= 70) bull += 2;
  if (rv >= 30 && rv <= 45) bear += 2;
  const vols = k15mClosed.map((c) => c.vol);
  const va = ind.sma(vols, 20);
  const spike = ind.last(va) > 0 ? ind.last(vols) / ind.last(va) : 0;
  if (spike >= 1.2) bull += 2; if (spike >= 1.2) bear += 1; // volume favors breakout side
  const ob = ind.obv(k15mClosed);
  if (ob[ob.length - 1] > ob[ob.length - 4]) bull += 1; else bear += 1;
  const st = ind.structure(safeTail(k15mClosed, 60), 2, 3);
  if (st === 'HH_HL') bull += 1;
  if (st === 'LH_LL') bear += 1;
  const score = Math.max(bull, bear) * 5; // 0..~55 quick bias
  const direction = bull > bear + 1 ? 'LONG' : bear > bull + 1 ? 'SHORT' : 'NEUTRAL';
  return { score, direction };
}

module.exports = { WEIGHTS, evaluate, quickEvaluate, classify };
