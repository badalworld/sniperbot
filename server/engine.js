'use strict';
/* Bot engine — season management, compounding, strategy execution, position management,
 * risk halts, reconciliation (manual close detection), robot events. */
const store = require('./store');
const ind = require('./indicators');
const ai = require('./aiscore');
const strat = require('./strategy');
const { MexcClient, INTERVAL_SEC } = require('./mexc');
const { logger, clamp, round, publicIP, sleep } = require('./util');

const DEFAULTS = {
  apiKey: '', secretKey: '',
  leverage: 10,               // x
  startMargin: 2,             // $ compounding base at season start
  maxOpenTrades: 5,           // concurrent positions
  minVolume24h: 5000000,      // $ 24h turnover filter
  seasonTarget: 1000000,      // $ goal
  takeProfitRoi: 30,          // % ROI on margin
  stopLossRoi: 30,            // % ROI on margin
  trailTriggerRoi: 30,        // activate trail after this ROI (OBV mode)
  trailDistancePct: 0.5,      // trail distance % of price
  minAiScore: 70,             // only trade >= 70
  strategy: 'scalp_3m',       // 'scalp_3m' | 'obv_compound'
  min15mMove: 2,              // % 15m move filter (OBV mode, Phase 5)
  scalpMinMove: 1,            // % move in last 15-30min (scalp mode, Phase 6)
  volumeSpike: 1.3,           // x avg5 volume spike
  maxHoldMin: 18,             // scalp timeout (6 x 3m candles)
  maxConsecutiveLosses: 3,
  dailyDrawdownPct: 5,
  cooldownAfterLossSec: 90,
  btcFilterPct: 1.5,          // block entries when BTC 15m move >= this %
  voice: true,
  port: 8080,
};

/* Translates raw MEXC errors into actionable messages for live trading */
function friendlyMexcError(e) {
  const m = String((e && e.message) || e);
  if (/timestamp|recv.?window|expired|request.?time/i.test(m)) return m + ' — your PC clock is out of sync. Sync your system clock and restart the bot.';
  if (/signature|sign|apikey|api.?key/i.test(m)) return m + ' — check your API key/secret and that your IP is allowed (Futures trade permission must be ON).';
  if (/position.?mode|one.?way|hedge/i.test(m)) return m + ' — set your MEXC Futures account to Hedge Mode (Preferences → Position Mode).';
  if (/insufficient|balance|margin/i.test(m)) return m + ' — not enough available USDT margin.';
  if (/leverage/i.test(m)) return m + ' — leverage not allowed for this symbol, lower it in settings.';
  if (/risk.?limit|limit/i.test(m)) return m + ' — symbol risk limit reached, try a smaller margin.';
  return m;
}

function todayKey(ts) { const d = new Date(ts || Date.now()); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

class Engine {
  constructor(scanner) {
    this.bootAt = Date.now();
    this.client = new MexcClient({});
    this.scanner = scanner;
    this.settings = Object.assign({}, DEFAULTS, store.load('settings', {}));
    this.scanner.setMinVolume(this.settings.minVolume24h);
    this.client.setKeys(this.settings.apiKey, this.settings.secretKey);

    const saved = store.load('state', {});
    this.completed = saved.completed || [];
    this.sessions = saved.sessions || [];
    this.stats = Object.assign({ wins: 0, losses: 0, consecutiveLosses: 0, executedTotal: 0, bestPnl: 0, worstPnl: 0 }, saved.stats || {});
    this.baseMargin = saved.baseMargin || this.settings.startMargin;
    this.lastPnl = saved.lastPnl || 0;
    this.season = saved.season || null;
    this.daily = saved.daily && saved.daily.key === todayKey() ? saved.daily : { key: todayKey(), startBalance: null, pnl: 0, halted: false };
    this.hasKeysSaved = Boolean(this.settings.apiKey && this.settings.secretKey);

    this.running = false;
    this.halted = false;
    this.haltReason = '';
    this.cooldownUntil = 0;
    this.btcBlockUntil = 0;
    this.btcMove = 0;
    this.positions = new Map();
    this.feed = [];
    this.scanLog = [];
    this.balance = { equity: null, available: null, positionMargin: null, unrealized: null, updatedAt: null, ok: null, error: null };
    this.ip = { public: null, lan: [], port: this.settings.port };
    this.timers = [];
    this.evalBuckets = { m3: 0, m15: 0 };
    this.exitBuckets = new Map();
    this.openBusy = new Set();
    this.symbolBlocks = new Map(); // "SYM|LONG" -> until ts
    this.tradeSeq = saved.tradeSeq || (this.completed.length || 0);
  }

  /* ---------------- events / robot ---------------- */
  emit(type, msg, data) {
    const ev = { ts: Date.now(), type, msg, data: data || null };
    this.feed.unshift(ev);
    if (this.feed.length > 60) this.feed.length = 60;
    if (this.onEvent) this.onEvent(ev);
    return ev;
  }

  /* ---------------- settings ---------------- */
  updateSettings(patch, opts) {
    /* AUDIT FIX: every numeric setting is validated & clamped to a safe range
     * (previously an empty input could inject 0 / NaN into the engine math). */
    const NUM_RANGE = {
      leverage: [1, 200], maxOpenTrades: [1, 20], startMargin: [0.5, 1e6],
      minVolume24h: [1e5, 1e10], seasonTarget: [10, 1e12],
      takeProfitRoi: [1, 500], stopLossRoi: [1, 500], trailTriggerRoi: [1, 500],
      trailDistancePct: [0.05, 20], minAiScore: [0, 100], min15mMove: [0, 50],
      scalpMinMove: [0, 50], volumeSpike: [1, 10], maxHoldMin: [3, 1440],
      maxConsecutiveLosses: [1, 20], dailyDrawdownPct: [0.5, 100],
      cooldownAfterLossSec: [0, 7200], btcFilterPct: [0.1, 20],
    };
    const keys = Object.keys(DEFAULTS);
    for (const k of keys) {
      if (patch[k] === undefined) continue;
      let v = patch[k];
      if (NUM_RANGE[k]) {
        if (v === '' || v === null) continue; // empty input = no change (audit fix)
        const n = Number(v);
        if (!isFinite(n)) continue; // ignore garbage input, keep current value
        v = clamp(n, NUM_RANGE[k][0], NUM_RANGE[k][1]);
      } else if (k === 'port') {
        const n = parseInt(v, 10);
        if (!isFinite(n)) continue;
        v = clamp(n, 1, 65535);
      } else if (k === 'voice') v = Boolean(v);
      else if (k === 'strategy') v = (v === 'obv_compound' ? 'obv_compound' : 'scalp_3m');
      if (k === 'apiKey' || k === 'secretKey') continue; // keys handled separately
      this.settings[k] = v;
    }
    /* AUDIT FIX: keys are only replaced when BOTH non-empty values arrive —
     * saving settings with blank key fields can no longer wipe stored keys. */
    if (opts && !this.running) {
      const nk = String(opts.apiKey || '').trim();
      const ns = String(opts.secretKey || '').trim();
      if (nk && ns) {
        this.settings.apiKey = nk;
        this.settings.secretKey = ns;
        this.client.setKeys(nk, ns);
        this.hasKeysSaved = true;
      }
    }
    this.scanner.setMinVolume(this.settings.minVolume24h);
    if (patch.port) this.ip.port = this.settings.port;
    store.save('settings', this.settings);
    return this.settings;
  }

  maskedSettings() {
    const s = Object.assign({}, this.settings);
    s.apiKey = s.apiKey ? s.apiKey.slice(0, 4) + '••••••••' + s.apiKey.slice(-4) : '';
    s.secretKey = s.secretKey ? '••••••••••••••••' : '';
    return s;
  }

  /* ---------------- lifecycle ---------------- */
  async start(patch) {
    if (this.running) return { ok: false, error: 'Already running' };
    if (patch) {
      const apiKey = patch.apiKey !== undefined ? String(patch.apiKey).trim() : this.settings.apiKey;
      const secretKey = patch.secretKey !== undefined ? String(patch.secretKey).trim() : this.settings.secretKey;
      const { apiKey: _a, secretKey: _s, ...rest } = patch;
      this.updateSettings(rest, { apiKey, secretKey });
    }
    if (!this.settings.apiKey || !this.settings.secretKey) return { ok: false, error: 'MEXC API key and secret key are required' };
    try { this.client.setKeys(this.settings.apiKey, this.settings.secretKey); } catch (e) { return { ok: false, error: e.message }; }

    // validate keys with a signed call
    let startBalance = null;
    try {
      const u = await this.client.usdt();
      if (!u) return { ok: false, error: 'USDT asset not found on your MEXC Futures account' };
      startBalance = +u.equity;
      this.balance = { equity: +u.equity, available: +u.availableBalance, positionMargin: +u.positionMargin, unrealized: +u.unrealized, updatedAt: Date.now(), ok: true, error: null };
    } catch (e) {
      return { ok: false, error: 'MEXC API validation failed: ' + friendlyMexcError(e) };
    }

    // season start
    if (!this.season || this.season.status !== 'RUNNING') {
      this.season = {
        id: 'S' + Date.now(),
        startedAt: Date.now(),
        startBalance: startBalance,        // rule: season starts at CURRENT balance
        target: this.settings.seasonTarget,
        status: 'RUNNING',
        realizedPnl: 0,
        peakBalance: startBalance,
      };
      this.baseMargin = this.settings.startMargin;  // compounding resets to configured base
      this.tradeSeq = 0;
      this.emit('session', `Season ${this.season.id} started. Balance $${round(startBalance, 2)} — target $${Number(this.season.target).toLocaleString()}`);
    } else {
      this.season.status = 'RUNNING';
      this.emit('session', 'Bot resumed on the active season.');
    }
    if (!this.daily.startBalance) this.daily.startBalance = startBalance;
    this.daily.halted = false;
    this.halted = false; this.haltReason = '';
    this.running = true;
    this.startLoops();
    store.save('state', this.snapshotState(), true);
    return { ok: true, balance: startBalance };
  }

  async stop(closePositions) {
    if (!this.running) return { ok: false, error: 'Not running' };
    this.running = false;
    this.stopLoops(); // loops must not fight the shutdown sequence
    let closed = 0;
    if (closePositions) {
      for (const [sym, pos] of Array.from(this.positions)) {
        try { await this.closePosition(pos, 'Season stop', 'MANUAL'); closed++; } catch (e) { logger.error('stop close ' + sym + ': ' + e.message); }
      }
      // give closes a moment to settle, then force reconciliation so the
      // closed trades are recorded even though the engine is no longer running
      await sleep(2500);
      this.forceReconcile = true;
      try { await this.reconcile(); } catch (e) { logger.warn('stop reconcile: ' + e.message); }
      this.forceReconcile = false;
    }
    if (this.season && this.season.status === 'RUNNING') {
      this.season.status = 'STOPPED';
      this.season.endedAt = Date.now();
      const endBal = this.balance.equity != null ? this.balance.equity : this.season.startBalance;
      const spark = this.completed.slice(-40).map((t) => t.cumPnl);
      this.sessions.unshift({
        id: this.season.id, startedAt: this.season.startedAt, endedAt: Date.now(),
        startBalance: this.season.startBalance, endBalance: endBal,
        pnl: round(endBal - this.season.startBalance, 4),
        trades: this.tradeSeq, wins: this.stats.wins, losses: this.stats.losses,
        sparkline: spark.length ? spark : [0],
      });
      if (this.sessions.length > 60) this.sessions.length = 60;
      this.emit('session', `Season stopped. ${this.tradeSeq} trades this season.`);
    }
    this.stopLoops();
    store.save('state', this.snapshotState(), true);
    return { ok: true, closed };
  }

  startLoops() {
    if (this.timers.length) return;
    this.timers.push(setInterval(() => this.tick().catch((e) => logger.error('tick: ' + e.message)), 1000));
    this.timers.push(setInterval(() => this.slowLoop().catch((e) => logger.debug('slow: ' + e.message)), 5000));
    this.timers.push(setInterval(() => this.reconcile().catch((e) => logger.debug('recon: ' + e.message)), 8000));
    this.timers.push(setInterval(() => this.strategyCheck().catch((e) => logger.debug('strategy: ' + e.message)), 2000));
  }
  stopLoops() { this.timers.forEach(clearInterval); this.timers = []; }

  /* ---------------- 1s fast loop: manage open positions ---------------- */
  async tick() {
    if (!this.running) return;
    const now = Date.now();
    for (const [sym, pos] of Array.from(this.positions)) {
      if (pos.settling || pos.closing) continue;
      try { this.managePosition(pos, now); } catch (e) { logger.error('manage ' + sym + ': ' + e.message); }
    }
  }

  managePosition(pos, now) {
    const price = this.scanner.fairPrice(pos.symbol);
    if (!price) return;
    pos.mark = price;
    pos.roi = strat.priceToRoi(pos.entryPrice, price, pos.leverage, pos.side === 'LONG');
    pos.pnl = strat.pnlUsd(pos.im || pos.margin, pos.roi);
    const long = pos.side === 'LONG';

    const mode = pos.adopted ? 'obv_compound' : pos.strategy;
    if (mode === 'obv_compound') {
      /* trail first: at TP ROI the trail ARMS (per spec: "trail stop only TP 30% ROI hit
       * then 0.5% to make maximum profit") — no hard close while trailing is possible */
      pos.trail = strat.trailUpdate(pos.trail, price, long, this.settings.trailTriggerRoi, pos.roi, this.settings.trailDistancePct);
      pos.trailStatus = !pos.trail.active
        ? 'WAITING (' + round(pos.roi, 1) + '%/' + this.settings.trailTriggerRoi + '%)'
        : 'ARMED @ ' + round(pos.trail.stop, price < 1 ? 5 : 2);
      /* hard TP only when trailing never armed (trigger set above TP) */
      if (!pos.trail.active && (long ? price >= pos.tpPrice : price <= pos.tpPrice)) {
        this.closePosition(pos, 'TP hit (+' + round(pos.roi, 1) + '% ROI)', 'TP');
        return;
      }
      const slPrice = pos.slPrice;
      if (long ? price <= slPrice : price >= slPrice) {
        this.closePosition(pos, 'SL hit (' + round(pos.roi, 1) + '% ROI)', 'SL');
        return;
      }
      if (strat.trailHit(pos.trail, price, long)) {
        this.closePosition(pos, 'Trailing stop locked +$' + round(pos.pnl, 2), 'TRAIL');
        return;
      }
    } else {
      /* scalp_3m management: TP1 (15%) -> close 50% + SL to breakeven + trail EMA21 ; TP2 (30%) -> close rest */
      if (pos.closing) return;
      const tp1 = strat.roiToPrice(pos.entryPrice, pos.leverage, 15, long);
      const tp2 = strat.roiToPrice(pos.entryPrice, pos.leverage, this.settings.takeProfitRoi, long);
      pos.tp1Price = tp1; pos.tp2Price = tp2;

      if (!pos.tp1Done && (long ? price >= tp1 : price <= tp1)) {
        pos.tp1Done = true;
        const halfVol = Math.max(1, Math.floor(pos.vol / 2));
        if (halfVol < pos.vol) {
          this.partialClose(pos, halfVol, 'TP1 +15% — closed 50%, SL → breakeven');
        } else {
          this.closePosition(pos, 'TP1 +15% ROI (volume too small to split)', 'TP');
          return;
        }
      }
      if (pos.tp1Done) {
        // trail SL at EMA21 (long: above breakeven), ratchet
        const ema21 = this.ema21Now(pos.symbol);
        if (ema21) {
          const be = pos.entryPrice * (1 + (long ? 1 : -1) * 0.0002); // breakeven + tiny buffer
          pos.slPrice = strat.scalpTrailStop(pos.side, ema21, be, pos.slPrice);
        }
        if (long ? price <= pos.slPrice : price >= pos.slPrice) {
          this.closePosition(pos, 'EMA21 trailing stop / breakeven protected', 'TRAIL');
          return;
        }
      } else {
        // initial structure SL with -30% ROI cap; exchange-side SL also attached at open
        const structSl = strat.cappedStop(pos.initSlPrice, pos.entryPrice, pos.leverage, this.settings.stopLossRoi, pos.side);
        pos.slPrice = structSl;
      }
      if (long ? price <= pos.slPrice : price >= pos.slPrice) {
        this.closePosition(pos, 'Stop loss (' + round(pos.roi, 1) + '% ROI)', 'SL');
        return;
      }
      if (long ? price >= tp2 : price <= tp2) {
        this.closePosition(pos, 'TP2 +' + this.settings.takeProfitRoi + '% ROI', 'TP');
        return;
      }
      /* exit engine — evaluated once per closed 3m candle */
      const bucket = Math.floor(now / (3 * 60 * 1000));
      if ((this.exitBuckets.get(pos.symbol) || 0) !== bucket && bucket * 3 * 60 * 1000 + 6000 < now) {
        this.exitBuckets.set(pos.symbol, bucket);
        this.scalpExitCheck(pos);
      }
    }
  }

  async scalpExitCheck(pos) {
    try {
      const k1m = await this.scanner.klines(pos.symbol, 'Min1', 130);
      const k3m = ind.dropForming(ind.aggregate(k1m, 3), 180);
      const res = strat.scalpExit({
        side: pos.side, k3mClosed: k3m, openedAt: pos.openTime,
        entryPrice: pos.entryPrice, leverage: pos.leverage,
        inProfit: pos.roi > 0, maxHoldMin: this.settings.maxHoldMin,
      });
      if (res && res.exit && !pos.closing) this.closePosition(pos, res.reason, 'ENGINE');
    } catch (e) { logger.debug('exitCheck ' + pos.symbol + ': ' + e.message); }
  }

  ema21Now(symbol) {
    // quick EMA21 on 3m from cached scanner klines (best-effort)
    const key = symbol + '|Min1';
    const c = this.scanner.klineCache.get(key);
    if (!c) return null;
    const k3m = ind.dropForming(ind.aggregate(c.candles, 3), 180);
    if (k3m.length < 25) return null;
    const e = ind.ema(k3m.map((x) => x.close), 21);
    return ind.last(e);
  }

  /* ---------------- 5s loop: balance + AI refresh for open positions ---------------- */
  async slowLoop() {
    try {
      const u = await this.client.usdt();
      if (u) {
        this.balance = { equity: +u.equity, available: +u.availableBalance, positionMargin: +u.positionMargin, unrealized: +u.unrealized, updatedAt: Date.now(), ok: true, error: null };
        if (this.season && this.season.status === 'RUNNING') {
          this.season.peakBalance = Math.max(this.season.peakBalance || 0, +u.equity);
        }
        if (this.daily.startBalance == null) this.daily.startBalance = +u.equity;
      }
    } catch (e) {
      this.balance.ok = false; this.balance.error = e.message;
      logger.debug('balance: ' + e.message);
    }
    // BTC instability filter
    try {
      const k15 = ind.dropForming(await this.scanner.klines('BTC_USDT', 'Min15', 8), 900);
      if (k15.length >= 3) {
        const chg = (k15[k15.length - 1].close - k15[k15.length - 2].close) / k15[k15.length - 2].close * 100;
        this.btcMove = chg;
        if (Math.abs(chg) >= this.settings.btcFilterPct && Date.now() > this.btcBlockUntil) {
          this.btcBlockUntil = Date.now() + 15 * 60 * 1000;
          this.emit('alert', `BTC moved ${round(chg, 2)}% in 15m — new entries paused 15 min (market instability filter)`);
        }
      }
    } catch (e) { /* ignore */ }
    // AI score refresh on open positions (live)
    for (const [sym, pos] of Array.from(this.positions)) {
      this.evaluateAi(sym, { live: true }).then((r) => {
        if (r) { pos.aiScore = r.score; pos.aiDirection = r.direction; pos.aiBreakdown = r.breakdown; pos.aiClass = r.classification; }
      }).catch(() => {});
    }
    store.save('state', this.snapshotState());
  }

  /* ---------------- reconciliation: manual closes & fills ---------------- */
  async reconcile() {
    if (!this.running && !this.forceReconcile) return;
    let openList;
    try { openList = await this.client.openPositions(); } catch (e) { return; }
    const ex = new Map();
    for (const p of openList) {
      if (p.state === 3 || +p.holdVol === 0) continue;
      ex.set(p.symbol, p);
    }
    for (const [sym, pos] of Array.from(this.positions)) {
      const ep = ex.get(sym);
      if (!ep) {
        // position gone from exchange (manual close, exchange SL/TP, or liquidation)
        let price = this.scanner.fairPrice(sym) || pos.mark || pos.entryPrice;
        let realized = null;
        // best-effort: fetch the exchange's actual realized PnL & close price from position history
        if (pos.positionId) {
          try {
            const hist = await this.client.historyPositions(1, 50);
            const match = (hist || []).find((h) => +h.positionId === +pos.positionId);
            if (match) {
              if (+match.closeAvgPrice > 0) price = +match.closeAvgPrice;
              if (match.realised !== undefined && match.realised !== null) realized = +match.realised;
            }
          } catch (e) { /* estimate instead */ }
        }
        const roiNow = strat.priceToRoi(pos.entryPrice, price, pos.leverage, pos.side === 'LONG');
        const exitType = pos.closing ? (pos.pendingExitType || 'TP') : (roiNow <= 0 ? 'SL' : 'MANUAL');
        const reason = pos.closing ? pos.closeReason : 'Closed on MEXC app (manual close detected)';
        this.finalizeClose(pos, price, exitType, reason, realized);
        continue;
      }
      // refresh live values
      pos.positionId = ep.positionId;
      pos.vol = +ep.holdVol;
      pos.im = +ep.im || pos.im;
      if (+ep.holdAvgPrice > 0) pos.entryPrice = +ep.holdAvgPrice;
      pos.liquidation = +ep.liquidatePrice || null;
      pos.exchangePnl = +ep.pnl || 0;
      if (pos.closing && pos.closeOrderSentAt && Date.now() - pos.closeOrderSentAt > 25000) {
        // close order didn't take effect — retry once
        pos.closing = false;
        logger.warn('close retry for ' + sym);
        this.closePosition(pos, pos.closeReason || 'retry', pos.pendingExitType || 'ENGINE').catch(() => {});
      }
    }
    // AUDIT FIX: adopt positions that exist on the exchange but are not tracked
    // locally (e.g. the bot restarted while positions were open, or the user
    // opened one manually) — otherwise they would be invisible & unmanaged.
    for (const [sym, ep] of ex) {
      if (this.positions.has(sym)) continue;
      this.adoptPosition(sym, ep);
    }
    store.save('state', this.snapshotState());
  }

  adoptPosition(symbol, ep) {
    try {
      const s = this.settings;
      const long = +ep.positionType === 1;
      const lev = clamp(+ep.leverage || s.leverage, 1, 200);
      const entry = +ep.holdAvgPrice || this.scanner.fairPrice(symbol);
      if (!entry || entry <= 0) return;
      const pos = {
        id: ++this.tradeSeq, symbol, side: long ? 'LONG' : 'SHORT',
        strategy: s.strategy, adopted: true,
        margin: round(+ep.im || 0, 2), leverage: lev, vol: +ep.holdVol,
        entryPrice: entry, mark: entry, entryKnown: true,
        aiScore: null, aiDirection: null, aiBreakdown: null, aiClass: null, confirmations: null,
        entryReason: 'Adopted from MEXC (opened outside the bot or bot restarted)',
        tpPrice: strat.roiToPrice(entry, lev, s.takeProfitRoi, long),
        slPrice: strat.stopPrice(entry, lev, s.stopLossRoi, long),
        tp1Price: strat.roiToPrice(entry, lev, 15, long),
        tp2Price: strat.roiToPrice(entry, lev, s.takeProfitRoi, long),
        initSlPrice: strat.stopPrice(entry, lev, s.stopLossRoi, long),
        trail: { active: false, peak: null, stop: null }, trailStatus: 'WAITING',
        openTime: Date.now(), positionId: ep.positionId,
        roi: 0, pnl: 0, tp1Done: false, closing: false,
      };
      this.positions.set(symbol, pos);
      this.emit('alert', `Adopted an open position on ${symbol} (${pos.side}, ${lev}x) — managing it with your TP/SL rules`);
      logger.info(`ADOPTED ${symbol} ${pos.side} vol=${pos.vol} entry=${entry}`);
    } catch (e) { logger.warn('adopt ' + symbol + ': ' + e.message); }
  }

  /* ---------------- strategy evaluation ---------------- */
  async strategyCheck() {
    if (!this.running || this.halted) return;
    const now = Date.now();
    const b3 = Math.floor(now / (3 * 60 * 1000));
    const b15 = Math.floor(now / (15 * 60 * 1000));
    if (b3 !== this.evalBuckets.m3 && now % (3 * 60 * 1000) >= 5000) {
      this.evalBuckets.m3 = b3;
      this.evaluationRound('3m').catch((e) => logger.warn('eval3m: ' + e.message));
    }
    if (b15 !== this.evalBuckets.m15 && now % (15 * 60 * 1000) >= 11000) {
      this.evalBuckets.m15 = b15;
      this.evaluationRound('15m').catch((e) => logger.warn('eval15m: ' + e.message));
    }
  }

  gateStatus() {
    const now = Date.now();
    if (this.positions.size >= this.settings.maxOpenTrades) return 'MAX_POS';
    if (this.cooldownUntil > now) return 'COOLDOWN';
    if (this.btcBlockUntil > now) return 'BTC_FILTER';
    if (this.halted) return 'HALTED: ' + this.haltReason;
    return null;
  }

  async evaluationRound(tf) {
    const gate = this.gateStatus();
    if (gate) { logger.debug('eval skipped: ' + gate); return; }
    const syms = this.scanner.eligible.filter((s) => !this.positions.has(s));
    // prioritize symbols the scanner has already scored highly
    const scored = syms.map((s) => ({ s, q: this.scanner.bySymb.get(s) }));
    scored.sort((a, b) => ((b.q && b.q.quickScore) || 0) - ((a.q && a.q.quickScore) || 0));
    const list = scored.slice(0, 10).map((x) => x.s);
    let opened = 0;
    for (const symbol of list) {
      if (opened >= 2) break;
      if (this.gateStatus()) break;
      if (this.openBusy.has(symbol)) continue;
      this.openBusy.add(symbol);
      try {
        const res = await this.evaluateAi(symbol, {});
        if (!res) continue;
        this.pushScanLog({ symbol, score: res.score, direction: res.direction, tradable: res.tradable, reason: (res.reasons || []).join('; ') || res.signalReason || 'analyzed', ts: Date.now() });
        if (!res.tradable) continue;
        if (this.positions.size >= this.settings.maxOpenTrades) break;
        let sig = null;
        if (this.settings.strategy === 'obv_compound') {
          const oc = strat.obvCrossSignal(res.k15m);
          if (oc.signal === 'BUY' && res.direction === 'LONG') sig = { side: 'LONG', entryPrice: this.scanner.price(symbol), reason: 'OBV crossed ABOVE EMA50 (15m)', confluence: res.confirmations };
          if (oc.signal === 'SELL' && res.direction === 'SHORT') sig = { side: 'SHORT', entryPrice: this.scanner.price(symbol), reason: 'OBV crossed BELOW EMA50 (15m)', confluence: res.confirmations };
          if (!sig && oc.signal) this.pushScanLog({ symbol, score: res.score, direction: oc.signal === 'BUY' ? 'LONG' : 'SHORT', tradable: false, reason: 'OBV cross found but AI filter rejected (' + res.direction + ' ' + res.score + ')', ts: Date.now() });
        } else {
          const k1m = await this.scanner.klines(symbol, 'Min1', 130);
          const k3m = ind.dropForming(ind.aggregate(k1m, 3), 180);
          const sc = strat.scalpSignal({
            k3mClosed: k3m, k15mClosed: res.k15m, ticker: this.scanner.tickers.get(symbol),
            minMovePct: this.settings.scalpMinMove, minVolSpike: this.settings.volumeSpike, lev: this.settings.leverage,
          });
          if (sc.signal === 'BUY' && res.direction === 'LONG') sig = { side: 'LONG', entryPrice: sc.entryPrice, reason: sc.reason, confluence: sc.confluence, initSl: sc.sl ? sc.sl.price : null };
          else if (sc.signal === 'SELL' && res.direction === 'SHORT') sig = { side: 'SHORT', entryPrice: sc.entryPrice, reason: sc.reason, confluence: sc.confluence, initSl: sc.sl ? sc.sl.price : null };
          else if (sc.signal) this.pushScanLog({ symbol, score: res.score, direction: sc.signal === 'BUY' ? 'LONG' : 'SHORT', tradable: false, reason: 'Strategy ' + sc.signal + ' but AI says ' + res.direction + ' (' + res.score + ')', ts: Date.now() });
          else if (tf === '3m') this.pushScanLog({ symbol, score: res.score, direction: res.direction, tradable: false, reason: sc.reason || 'no scalp signal', ts: Date.now() });
        }
        if (sig && sig.entryPrice) {
          const r = await this.openPosition(symbol, sig.side, res, sig);
          if (r && r.ok) opened++;
        }
      } catch (e) {
        logger.warn('eval ' + symbol + ': ' + e.message);
      } finally {
        this.openBusy.delete(symbol);
      }
      await sleep(400);
    }
  }

  pushScanLog(entry) {
    this.scanLog.unshift(entry);
    if (this.scanLog.length > 30) this.scanLog.length = 30;
  }

  /* full AI evaluation for a symbol (also used live for open positions) */
  async evaluateAi(symbol, opts) {
    const [k15raw, k1h, k4h] = await Promise.all([
      this.scanner.klines(symbol, 'Min15', 210),
      this.scanner.klines(symbol, 'Min60', 70).catch(() => null),
      this.scanner.klines(symbol, 'Hour4', 70).catch(() => null),
    ]);
    if (!opts.live && this.settings.strategy === 'scalp_3m') {
      // make sure real 3m candles exist before scoring (otherwise 15m proxies in)
      await this.scanner.klines(symbol, 'Min1', 130).catch(() => null);
    }
    const k15m = ind.dropForming(k15raw, INTERVAL_SEC.Min15);
    const t = this.scanner.tickers.get(symbol) || {};
    const bundle = {
      symbol,
      price: +t.lastPrice || ind.last(k15m).close,
      fundingRate: +t.fundingRate || 0,
      oiNow: +t.holdVol || null,
      oi15mAgo: this.scanner.oi15mAgo(symbol),
      k3m: (() => {
        const c = this.scanner.klineCache.get(symbol + '|Min1');
        if (!c) return k15m.slice(-30); // fallback proxy until 1m cache exists
        return ind.dropForming(ind.aggregate(c.candles, 3), 180);
      })(),
      k15m, k1h: k1h ? ind.dropForming(k1h, 3600) : null, k4h: k4h ? ind.dropForming(k4h, 14400) : null,
    };
    const res = ai.evaluate(bundle);
    // hard professional filters
    if (Math.abs(bundle.fundingRate) > 0.0015) {
      res.tradable = false;
      res.reasons.push('Funding overheated');
    }
    const blockKey = symbol + '|' + res.direction;
    if ((this.symbolBlocks.get(blockKey) || 0) > Date.now()) {
      res.tradable = false;
      res.reasons.push('Fake breakout cooldown on ' + symbol);
    }
    if ((res.notes || []).some((n) => /Fake breakout/i.test(n))) {
      this.symbolBlocks.set(symbol + '|' + res.direction, Date.now() + 30 * 60 * 1000);
    }
    if (!opts.live && this.settings.strategy === 'obv_compound') {
      // Phase 5 filter: only trade coins that moved >= min15mMove % in last 15m candle
      const m15 = strat.move15to30(k15m);
      res.move15 = round(m15, 2);
      if (m15 < this.settings.min15mMove) {
        res.tradable = false;
        res.reasons.push(`15m move ${round(m15, 2)}% < ${this.settings.min15mMove}% (momentum filter)`);
      }
    }
    return res;
  }

  /* ---------------- order execution ---------------- */
  async openPosition(symbol, side, aiRes, sig) {
    const s = this.settings;
    if (this.positions.size >= s.maxOpenTrades) return { ok: false, error: 'max open trades reached' };
    if (this.positions.has(symbol)) return { ok: false, error: 'position already open on ' + symbol };
    const t = this.scanner.tickers.get(symbol);
    const d = this.scanner.details.get(symbol);
    if (!t || !t.lastPrice) return { ok: false, error: 'no price' };
    if (!d || !d.contractSize) return { ok: false, error: 'no contract info' };
    const price = this.scanner.fairPrice(symbol) || +t.lastPrice; // live price source, same as monitoring
    const lev = clamp(s.leverage, 1, +d.maxLeverage || s.leverage);
    const long = side === 'LONG';
    const margin = round(this.baseMargin, 2);
    if (margin < 0.5) { this.emit('alert', 'Compounding margin below $0.50 — trading paused. Increase Start Margin in settings.'); this.halted = true; this.haltReason = 'margin floor'; return { ok: false }; }

    // affordability
    let u = null;
    try { u = await this.client.usdt(); } catch (e) { return { ok: false, error: 'balance unavailable: ' + e.message }; }
    const available = +u.availableBalance;
    let vol = Math.floor((margin * lev) / ((+d.contractSize) * price));
    if (vol < 1) vol = 1;
    let needed = vol * (+d.contractSize) * price / lev;
    if (needed > margin * 2.5) { logger.info('skip ' + symbol + ': 1 contract needs $' + round(needed, 2) + ' margin (base $' + margin + ')'); return { ok: false, error: 'contract too large for margin' }; }
    if (needed > available * 0.95) { logger.info('skip ' + symbol + ': insufficient balance (need $' + round(needed, 2) + ', available $' + round(available, 2) + ')'); return { ok: false, error: 'insufficient balance' }; }

    // SL price: scalp = structure capped; obv = ROI-based
    let slPrice;
    if (s.strategy === 'scalp_3m' && sig.initSl) slPrice = strat.cappedStop(sig.initSl, price, lev, s.stopLossRoi, side);
    else slPrice = strat.stopPrice(price, lev, s.stopLossRoi, long);
    const priceScale = d.priceScale != null ? +d.priceScale : 4;
    slPrice = Number(slPrice.toFixed(priceScale));

    const externalOid = 'bwf' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    let orderRes = null;
    try {
      orderRes = await this.client.createOrder({
        symbol, price, vol, side: long ? 1 : 3, type: 5, openType: 1,
        leverage: lev, stopLossPrice: slPrice, externalOid,
      });
    } catch (e) {
      const msg = friendlyMexcError(e);
      logger.error('OPEN FAIL ' + symbol + ': ' + e.message);
      this.emit('alert', 'Order rejected on ' + symbol + ': ' + msg);
      return { ok: false, error: msg };
    }

    const pos = {
      id: ++this.tradeSeq,
      symbol, side, strategy: s.strategy,
      margin: round(needed, 2), baseMarginUsed: margin,
      leverage: lev, vol, entryPrice: price, mark: price,
      aiScore: aiRes.score, aiDirection: aiRes.direction, aiBreakdown: aiRes.breakdown, aiClass: aiRes.classification,
      confirmations: aiRes.confirmations,
      entryReason: sig.reason, confluence: sig.confluence,
      tpPrice: strat.roiToPrice(price, lev, s.takeProfitRoi, long),
      slPrice,
      initSlPrice: slPrice,
      tp1Price: strat.roiToPrice(price, lev, 15, long),
      tp2Price: strat.roiToPrice(price, lev, s.takeProfitRoi, long),
      trail: { active: false, peak: null, stop: null },
      trailStatus: 'WAITING',
      openTime: Date.now(), orderId: orderRes.orderId, externalOid,
      roi: 0, pnl: 0, tp1Done: false, closing: false, entryKnown: false,
      settling: true, // tick() must not manage this position until the fill reconciles
    };
    this.positions.set(symbol, pos);

    // fetch the real position (entry price, im) — retries while fill settles
    try {
      for (let i = 0; i < 5; i++) {
        await sleep(1200);
      try {
        const list = await this.client.openPositions(symbol);
        const ep = list.find((p) => p.state !== 3 && +p.holdVol > 0);
        if (ep) {
          pos.positionId = ep.positionId;
          if (+ep.holdAvgPrice > 0) { pos.entryPrice = +ep.holdAvgPrice; pos.entryKnown = true; }
          pos.im = +ep.im || pos.margin;
          pos.vol = +ep.holdVol;
          pos.liquidation = +ep.liquidatePrice || null;
          // recompute targets off the real entry
          pos.tpPrice = strat.roiToPrice(pos.entryPrice, lev, s.takeProfitRoi, long);
          pos.tp1Price = strat.roiToPrice(pos.entryPrice, lev, 15, long);
          pos.tp2Price = strat.roiToPrice(pos.entryPrice, lev, s.takeProfitRoi, long);
          break;
        }
      } catch (e) { /* retry */ }
      }
    } finally {
      pos.settling = false;
    }
    this.emit('trade_open', `New trade open — congratulations! ${symbol} ${side} | margin $${round(pos.margin, 2)} x${lev} | AI ${aiRes.score}/100 (${aiRes.classification.label})`, { symbol, side, margin: pos.margin, aiScore: aiRes.score });
    logger.info(`OPEN ${symbol} ${side} vol=${vol} entry≈${pos.entryPrice} SL=${slPrice} TP=${pos.tpPrice} AI=${aiRes.score} conf=${aiRes.confirmations}`);
    store.save('state', this.snapshotState(), true);
    return { ok: true, pos };
  }

  async partialClose(pos, vol, reason) {
    const side = pos.side === 'LONG' ? 4 : 2;
    try {
      await this.client.createOrder({ symbol: pos.symbol, price: this.scanner.price(pos.symbol), vol, side, type: 5, openType: 1, positionId: pos.positionId, leverage: pos.leverage });
      pos.vol = Math.max(0, pos.vol - vol);
      pos.margin = round(pos.margin * (pos.vol / (pos.vol + vol) || 0), 4);
      // move SL to breakeven: replace exchange SL by closing remaining at BE via engine (exchange stop remains as disaster brake)
      this.emit('trade_info', `${pos.symbol}: ${reason}`, { symbol: pos.symbol });
      logger.info(`PARTIAL ${pos.symbol} closed ${vol} — ${reason}`);
      // record as a completed partial trade
      const price = this.scanner.fairPrice(pos.symbol) || pos.mark;
      const roi = strat.priceToRoi(pos.entryPrice, price, pos.leverage, pos.side === 'LONG');
      const pnl = strat.pnlUsd(pos.margin / Math.max(pos.vol, 1) * vol, roi);
      this.recordTrade(pos, price, 'TP1', reason, roi, pnl, pos.openTime, 'p1');
    } catch (e) {
      logger.error('partialClose ' + pos.symbol + ': ' + e.message);
    }
  }

  async closePosition(pos, reason, exitType) {
    if (pos.closing) return;
    pos.closing = true;
    pos.closeReason = reason;
    pos.pendingExitType = exitType;
    pos.closeOrderSentAt = Date.now();
    try {
      if (pos.positionId) {
        const side = pos.side === 'LONG' ? 4 : 2; // 4 close long, 2 close short
        const price = this.scanner.price(pos.symbol) || pos.mark;
        await this.client.createOrder({ symbol: pos.symbol, price, vol: pos.vol, side, type: 5, openType: 1, positionId: pos.positionId, leverage: pos.leverage });
        logger.info(`CLOSE order sent ${pos.symbol} (${exitType}): ${reason}`);
      } else {
        // never confirmed on exchange — drop local record
        this.finalizeClose(pos, pos.mark || pos.entryPrice, exitType, reason + ' (unconfirmed fill)');
      }
    } catch (e) {
      logger.error('CLOSE FAIL ' + pos.symbol + ': ' + e.message);
      pos.closing = false;
      pos.closeOrderSentAt = Date.now() - 30000; // let reconcile retry
      this.emit('alert', 'Close failed on ' + pos.symbol + ': ' + friendlyMexcError(e));
    }
  }

  /* finalize a trade: stats, compounding, robot events, persistence */
  finalizeClose(pos, exitPrice, exitType, reason) {
    if (!this.positions.has(pos.symbol)) return;
    this.positions.delete(pos.symbol);
    const long = pos.side === 'LONG';
    const roi = strat.priceToRoi(pos.entryPrice, exitPrice, pos.leverage, long);
    const pnl = round(strat.pnlUsd(pos.im || pos.margin, roi), 4);
    this.recordTrade(pos, exitPrice, exitType, reason, roi, pnl, pos.openTime);
  }

  recordTrade(pos, exitPrice, exitType, reason, roi, pnl, openedAt, idSuffix) {
    const t = {
      id: idSuffix ? pos.id + idSuffix : pos.id, season: this.season ? this.season.id : null,
      symbol: pos.symbol, side: pos.side, strategy: pos.strategy,
      margin: round(pos.im || pos.margin, 2), leverage: pos.leverage, vol: pos.vol,
      entry: pos.entryPrice, exit: exitPrice,
      roi: round(roi, 2), pnl,
      aiScore: pos.aiScore, confluence: pos.confluence || null,
      exitType, reason,
      openedAt, closedAt: Date.now(),
      holdSec: Math.round((Date.now() - openedAt) / 1000),
    };
    this.completed.push(t);
    if (this.completed.length > 2000) this.completed.splice(0, this.completed.length - 2000);
    this.lastPnl = pnl;

    // stats
    if (pnl > 0) { this.stats.wins++; this.stats.consecutiveLosses = 0; }
    else if (pnl < 0) { this.stats.losses++; this.stats.consecutiveLosses++; }
    this.stats.executedTotal++;
    this.stats.bestPnl = Math.max(this.stats.bestPnl, pnl);
    this.stats.worstPnl = Math.min(this.stats.worstPnl, pnl);
    if (this.season) this.season.realizedPnl = round((this.season.realizedPnl || 0) + pnl, 4);
    this.daily.pnl = round(this.daily.pnl + pnl, 4);

    // COMPOUNDING: margin follows profit/loss ratio, split across max open positions
    // e.g. $1 profit / 5 slots -> next trades use +$0.20 ; loss mirrors negative.
    const share = pnl / Math.max(1, this.settings.maxOpenTrades);
    this.baseMargin = round(clamp(this.baseMargin + share, 0.5, Math.max(0.5, (this.balance.equity || 100000) * 0.5)), 4);

    // robot
    if (pnl > 0) this.emit('trade_win', `This pair made profit! ${pos.symbol} +$${round(pnl, 2)} (${round(roi, 1)}% ROI). Compounding margin is now $${round(this.baseMargin, 2)}`, { symbol: pos.symbol, pnl });
    else if (pnl < 0) this.emit('trade_loss', `Sorry, we lost this pair. ${pos.symbol} -$${round(Math.abs(pnl), 2)} (${round(roi, 1)}% ROI). Margin adjusted to $${round(this.baseMargin, 2)}`, { symbol: pos.symbol, pnl });
    else this.emit('trade_info', `${pos.symbol} closed flat ($0.00) — ${reason}`, { symbol: pos.symbol });

    // risk halts
    if (pnl < 0) {
      this.cooldownUntil = Date.now() + this.settings.cooldownAfterLossSec * 1000; // no revenge trading
      if (this.stats.consecutiveLosses >= this.settings.maxConsecutiveLosses) {
        this.halted = true; this.haltReason = `${this.stats.consecutiveLosses} consecutive losses`;
        this.emit('alert', `Risk halt: ${this.stats.consecutiveLosses} losses in a row. New entries stopped — recover and restart the season.`);
      }
      const dd = this.daily.startBalance ? -this.daily.pnl / this.daily.startBalance * 100 : 0;
      if (dd >= this.settings.dailyDrawdownPct && !this.daily.halted) {
        this.daily.halted = true; this.halted = true; this.haltReason = `daily drawdown ${round(dd, 2)}%`;
        this.emit('alert', `Risk halt: daily drawdown ${round(dd, 2)}% reached. Trading paused for today.`);
      }
    }
    logger.info(`CLOSED ${pos.symbol} ${exitType} ${roi >= 0 ? '+' : ''}${round(roi, 1)}% ROI  $${pnl >= 0 ? '+' : ''}${round(pnl, 4)} — ${reason}`);
    store.save('state', this.snapshotState(), true);
  }

  /* ---------------- snapshot for dashboard ---------------- */
  livePositions() {
    const out = [];
    for (const pos of this.positions.values()) {
      out.push({
        id: pos.id, symbol: pos.symbol, side: pos.side, strategy: pos.strategy,
        margin: round(pos.im || pos.margin, 2), leverage: pos.leverage, vol: pos.vol,
        entry: pos.entryPrice, mark: pos.mark || pos.entryPrice,
        roi: round(pos.roi || 0, 2), pnl: round(pos.pnl || 0, 4),
        tpPrice: pos.tpPrice, tp1Price: pos.tp1Price, tp2Price: pos.tp2Price, slPrice: pos.slPrice,
        trail: pos.trail || { active: false }, trailStatus: pos.trailStatus || '—',
        aiScore: pos.aiScore, aiDirection: pos.aiDirection, aiBreakdown: pos.aiBreakdown || null, aiClass: pos.aiClass || null,
        confirmations: pos.confirmations, entryReason: pos.entryReason,
        openTime: pos.openTime, liquidation: pos.liquidation || null,
        closing: Boolean(pos.closing), tp1Done: Boolean(pos.tp1Done), entryKnown: Boolean(pos.entryKnown),
      });
    }
    return out.sort((a, b) => b.openTime - a.openTime);
  }

  seasonStats() {
    const wins = this.stats.wins, losses = this.stats.losses;
    const total = wins + losses;
    const seasonTrades = this.completed.filter((t) => this.season && t.season === this.season.id);
    const seasonPnl = seasonTrades.reduce((s, t) => s + t.pnl, 0);
    const grossWin = this.completed.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(this.completed.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return {
      executedSeason: seasonTrades.length,
      executedTotal: this.stats.executedTotal,
      wins, losses, winRate: total ? round(wins / total * 100, 1) : 0,
      consecutiveLosses: this.stats.consecutiveLosses,
      todayPnl: this.daily.pnl, todayHalted: this.daily.halted,
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : (grossWin > 0 ? 99 : 0),
      bestPnl: round(this.stats.bestPnl, 2), worstPnl: round(this.stats.worstPnl, 2),
      seasonPnl: round(seasonPnl, 4),
    };
  }

  snapshotState() {
    return {
      settings: this.settings, season: this.season, sessions: this.sessions,
      completed: this.completed, stats: this.stats,
      baseMargin: this.baseMargin, lastPnl: this.lastPnl, daily: this.daily, tradeSeq: this.tradeSeq,
    };
  }

  dashboard() {
    const now = Date.now();
    let d = null;
    try { d = this.dailyPnlSeries(); } catch (e) { d = []; }
    return {
      serverTime: now,
      version: '2.1',
      uptimeSec: Math.floor((now - (this.bootAt || now)) / 1000),
      running: this.running,
      halted: this.halted, haltReason: this.haltReason,
      cooldownUntil: this.cooldownUntil, btcBlockUntil: this.btcBlockUntil, btcMove: round(this.btcMove, 2),
      settings: this.maskedSettings(),
      season: this.season,
      baseMargin: round(this.baseMargin, 2), lastPnl: round(this.lastPnl, 4),
      balance: this.balance,
      stats: this.seasonStats(),
      positions: this.livePositions(),
      completed: this.completed.slice(-6).reverse(),
      scanner: this.scanner.snapshot(),
      scanLog: this.scanLog,
      feed: this.feed.slice(0, 24),
      logs: require('./util').logger.recent(14),
      ping: { ms: this.scanner.client.pingMs, ts: this.scanner.client.lastPingTs },
      ip: this.ip,
      dailySeries: d,
    };
  }

  dailyPnlSeries() {
    // cumulative pnl of the current season's trades for sparkline
    if (!this.season) return [];
    const list = this.completed.filter((t) => t.season === this.season.id);
    let c = 0;
    return list.map((t) => { c += t.pnl; return { t: t.closedAt, v: round(c, 4) }; });
  }
}

module.exports = { Engine, DEFAULTS };
