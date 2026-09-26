'use strict';
/* Technical indicators — pure functions over arrays of candles {t,open,high,low,close,vol,amount}.
 * All functions tolerate short series and return arrays aligned to input (prefix nulls where undefined). */

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = null; let sum = 0; let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || isNaN(v)) { out[i] = prev; continue; }
    if (prev == null) {
      sum += v; count++;
      if (count === period) { prev = sum / period; out[i] = prev; }
      else out[i] = null;
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/* Wilder RSI */
function rsi(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/* MACD {macd, signal, hist} — standard 12/26/9 */
function macd(closes, fast, slow, signalP) {
  fast = fast || 12; slow = slow || 26; signalP = signalP || 9;
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const firstIdx = line.findIndex((v) => v != null);
  const sigArr = firstIdx === -1 ? [] : ema(line.slice(firstIdx), signalP);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigArr.length; i++) signal[firstIdx + i] = sigArr[i];
  const hist = closes.map((_, i) => (line[i] != null && signal[i] != null ? line[i] - signal[i] : null));
  return { line, signal, hist };
}

/* ATR (Wilder) */
function atr(candles, period) {
  period = period || 14;
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/* On-Balance Volume */
function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i].close > candles[i - 1].close ? 1 : candles[i].close < candles[i - 1].close ? -1 : 0;
    out[i] = out[i - 1] + dir * candles[i].vol;
  }
  return out;
}

/* Swing pivots: index i is a pivot high if high[i] is max of window +-k (ties at equal price allowed).
 * Returns arrays of {idx, price}. */
function pivots(candles, k) {
  k = k || 2;
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high * (1 + 1e-9)) isH = false;
      if (candles[j].low < candles[i].low * (1 - 1e-9)) isL = false;
    }
    if (isH) highs.push({ idx: i, price: candles[i].high });
    if (isL) lows.push({ idx: i, price: candles[i].low });
  }
  return { highs, lows };
}

/* Market structure on recent pivots: 'HH_HL' | 'LH_LL' | 'MIXED' | 'NONE' */
function structure(candles, k, lookback) {
  const p = pivots(candles, k);
  const hs = p.highs.slice(-lookback || -4);
  const ls = p.lows.slice(-lookback || -4);
  if (hs.length < 2 || ls.length < 2) return 'NONE';
  const hh = hs[hs.length - 1].price > hs[hs.length - 2].price;
  const hl = ls[ls.length - 1].price > ls[ls.length - 2].price;
  const lh = hs[hs.length - 1].price < hs[hs.length - 2].price;
  const ll = ls[ls.length - 1].price < ls[ls.length - 2].price;
  if (hh && hl) return 'HH_HL';
  if (lh && ll) return 'LH_LL';
  return 'MIXED';
}

/* Aggregate 1m candles into N-minute candles (e.g., 3m). Drops the last (possibly incomplete) bucket
 * only if it is the current forming bucket AND incompleteMs is true. */
function aggregate(candles, minutes) {
  if (!candles.length) return [];
  const ms = minutes * 60 * 1000;
  const map = new Map();
  for (const c of candles) {
    const bucket = Math.floor(c.t * 1000 / ms) * ms;
    let b = map.get(bucket);
    if (!b) { b = { t: bucket / 1000, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol, amount: c.amount }; map.set(bucket, b); }
    else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.vol += c.vol;
      b.amount += c.amount;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

/* closed candles only: drop any candle whose bucket is still forming */
function dropForming(candles, intervalSec, nowSec) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  if (last.t + intervalSec > (nowSec || Math.floor(Date.now() / 1000))) return candles.slice(0, -1);
  return candles;
}

/* percent change of last closed candle volume vs average of previous N */
function volumeSpike(closed, avgN) {
  if (closed.length < avgN + 1) return 0;
  const cur = closed[closed.length - 1].vol;
  let sum = 0;
  for (let i = closed.length - 1 - avgN; i < closed.length - 1; i++) sum += closed[i].vol;
  const avg = sum / avgN;
  return avg > 0 ? cur / avg : 0;
}

/* wick analysis of last closed candle: returns {upperWickPct, lowerWickPct, bodyPct} of range */
function wick(c) {
  const range = c.high - c.low;
  if (range <= 0) return { upperWickPct: 0, lowerWickPct: 0, bodyPct: 0 };
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.close, c.open);
  const lower = Math.min(c.close, c.open) - c.low;
  return { upperWickPct: upper / range * 100, lowerWickPct: lower / range * 100, bodyPct: body / range * 100 };
}

function last(arr) { return arr.length ? arr[arr.length - 1] : null; }
function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

module.exports = { ema, sma, rsi, macd, atr, obv, pivots, structure, aggregate, dropForming, volumeSpike, wick, last, lastN };
