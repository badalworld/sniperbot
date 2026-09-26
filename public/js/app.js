'use strict';
/* Dashboard logic — binds the live snapshot into the UI, power button, settings modal. */
(() => {
  const $ = (id) => document.getElementById(id);
  let STATE = null;
  let lastEventTs = 0;
  let modalMode = 'start';

  /* ---------------- config fields ---------------- */
  const CFG = [
    { k: 'strategy', label: 'Strategy Mode', type: 'select', opts: [
      { v: 'scalp_3m', t: '⚡ 3M Scalping — EMA9/21 + RSI + VolSpike (Phase 6)' },
      { v: 'obv_compound', t: '🧪 OBV × EMA50 Compounding — 15M (Phase 1)' },
    ] },
    { k: 'leverage', label: 'Leverage (x)', type: 'number', min: 1, max: 50, step: 1 },
    { k: 'startMargin', label: 'Start Margin per Trade ($)', type: 'number', min: 0.5, max: 100000, step: 0.1 },
    { k: 'maxOpenTrades', label: 'Max Open Trades', type: 'number', min: 1, max: 20, step: 1, hint: 'compounding splits profit/loss across these slots' },
    { k: 'minVolume24h', label: 'Min 24h Volume ($)', type: 'number', min: 100000, step: 100000, hint: 'only coins above this turnover are traded' },
    { k: 'seasonTarget', label: 'Season Goal ($)', type: 'number', min: 10, step: 10 },
    { k: 'takeProfitRoi', label: 'Take Profit ROI (%)', type: 'number', min: 1, max: 300, step: 1 },
    { k: 'stopLossRoi', label: 'Stop Loss ROI (%)', type: 'number', min: 1, max: 300, step: 1 },
    { k: 'trailTriggerRoi', label: 'Trail Trigger ROI (%)', type: 'number', min: 1, max: 300, step: 1, hint: 'OBV mode: trail arms after this ROI' },
    { k: 'trailDistancePct', label: 'Trail Distance (% of price)', type: 'number', min: 0.1, max: 10, step: 0.1 },
    { k: 'minAiScore', label: 'Min AI Score (0–100)', type: 'number', min: 0, max: 100, step: 1, hint: 'only trades ≥ this score (you use 70)' },
    { k: 'min15mMove', label: '15M Move Filter % (OBV)', type: 'number', min: 0, max: 20, step: 0.1 },
    { k: 'scalpMinMove', label: 'Move 15–30min % (Scalp)', type: 'number', min: 0, max: 20, step: 0.1 },
    { k: 'volumeSpike', label: 'Volume Spike (× avg)', type: 'number', min: 1, max: 5, step: 0.1 },
    { k: 'maxHoldMin', label: 'Max Hold (minutes)', type: 'number', min: 3, max: 240, step: 1, hint: 'scalp timeout: 18min = 6× 3m candles' },
    { k: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'number', min: 1, max: 10, step: 1 },
    { k: 'dailyDrawdownPct', label: 'Daily Drawdown Halt (%)', type: 'number', min: 1, max: 50, step: 0.5 },
    { k: 'cooldownAfterLossSec', label: 'Cooldown After Loss (sec)', type: 'number', min: 0, max: 3600, step: 5, hint: 'anti-revenge-trading pause' },
    { k: 'btcFilterPct', label: 'BTC Instability Filter (%)', type: 'number', min: 0.5, max: 10, step: 0.1 },
  ];

  function renderCfg() {
    const grid = $('cfgGrid');
    grid.innerHTML = '';
    for (const f of CFG) {
      const wrap = document.createElement('div');
      wrap.className = 'field' + (f.type === 'select' ? ' full' : '');
      const id = 'cfg_' + f.k;
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        input.id = id;
        for (const o of f.opts) {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.t;
          input.appendChild(op);
        }
      } else {
        input = document.createElement('input');
        input.type = 'number'; input.id = id;
        input.min = f.min; input.max = f.max; input.step = f.step;
      }
      const lab = document.createElement('label');
      lab.htmlFor = id; lab.textContent = f.label;
      wrap.appendChild(lab); wrap.appendChild(input);
      if (f.hint) {
        const h = document.createElement('div');
        h.className = 'hint'; h.textContent = f.hint;
        wrap.appendChild(h);
      }
      grid.appendChild(wrap);
    }
  }

  function fillCfg(s) {
    for (const f of CFG) {
      const el = $('cfg_' + f.k);
      if (!el) continue;
      el.value = s[f.k];
    }
  }

  function readCfg() {
    const out = {};
    for (const f of CFG) {
      const el = $('cfg_' + f.k);
      if (el) out[f.k] = f.type === 'select' ? el.value : el.value;
    }
    return out;
  }

  /* ---------------- modal ---------------- */
  function openModal(mode) {
    modalMode = mode;
    const s = STATE ? STATE.settings : {};
    $('modalTitle').textContent = mode === 'start' ? 'LAUNCH CONFIGURATION' : 'BOT SETTINGS';
    $('modalSub').textContent = mode === 'start'
      ? 'Enter your MEXC Futures API keys — everything is stored locally on your machine only.'
      : 'Tune the engine live. Changes apply immediately to new trades.';
    $('keysSection').style.display = STATE && STATE.running ? 'none' : 'block';
    $('modalStartStop').textContent = mode === 'start' ? '🔌 SAVE & START' : '💾 SAVE CONFIG';
    $('modalStartStop').className = 'btn success';
    $('closeOnStopWrap').style.display = mode === 'stop' ? 'flex' : 'none';
    if (mode === 'stop') {
      $('modalTitle').textContent = 'STOP ENGINE';
      $('modalSub').textContent = 'The bot stops opening new trades. Open positions keep their exchange-side stop-loss.';
      $('modalStartStop').textContent = '⏹ STOP ENGINE';
      $('modalStartStop').className = 'btn danger';
    }
    $('fApiKey').value = '';
    $('fSecretKey').value = '';
    $('fApiKey').placeholder = s.apiKey ? 'Saved: ' + s.apiKey : 'Paste your MEXC API access key';
    fillCfg(s);
    $('modalIp').textContent = STATE && STATE.ip ? (STATE.ip.public || STATE.ip.lan?.[0] || 'not detected yet') : '…';
    $('modalLan').textContent = STATE && STATE.ip && STATE.ip.lan && STATE.ip.lan.length ? 'LAN: ' + STATE.ip.lan.join(', ') : '';
    $('modalBack').classList.add('show');
  }
  function closeModal() { $('modalBack').classList.remove('show'); }

  async function doStart() {
    const body = readCfg();
    const key = $('fApiKey').value.trim(), secret = $('fSecretKey').value.trim();
    if (key) body.apiKey = key;
    if (secret) body.secretKey = secret;
    const btn = $('modalStartStop');
    btn.disabled = true; btn.textContent = 'CONNECTING…';
    const r = await AI2.api('/api/start', 'POST', body);
    btn.disabled = false;
    if (!r.ok) {
      btn.textContent = '🔌 SAVE & START';
      AI2.toast('✘ ' + r.error, 'err');
      TradeMaster.event('alert', 'Connection failed. ' + r.error, {});
      return;
    }
    closeModal();
    AI2.toast('✔ Engine started — season is live!', 'ok');
  }

  async function doStop() {
    const close = $('closeOnStop').checked;
    const r = await AI2.api('/api/stop', 'POST', { closePositions: close });
    if (r.ok) {
      closeModal();
      AI2.toast('■ Engine stopped' + (r.closed ? ` — closed ${r.closed} position(s)` : ''), 'ok');
    } else AI2.toast('✘ ' + r.error, 'err');
  }

  async function doSave() {
    const body = readCfg();
    const key = $('fApiKey').value.trim(), secret = $('fSecretKey').value.trim();
    if (key) body.apiKey = key;
    if (secret) body.secretKey = secret;
    const r = await AI2.api('/api/settings', 'POST', body);
    if (r.ok) { AI2.toast('✔ Settings saved', 'ok'); closeModal(); }
    else AI2.toast('✘ ' + r.error, 'err');
  }

  /* ---------------- snapshot binding ---------------- */
  function render(s) {
    STATE = s;
    AI2.bindHeader(s);

    // power button
    const pb = $('powerBtn');
    pb.classList.toggle('running', s.running);
    $('powerLabel').textContent = s.running ? 'STOP' : 'START';
    $('powerHint').textContent = s.running
      ? 'Engine RUNNING — press to stop'
      : 'Engine stopped — press to configure & start';

    // engine status card
    let st = s.running ? 'RUNNING' : 'STANDBY';
    let stCls = s.running ? 'pos' : '';
    if (s.halted) { st = 'RISK HALT'; stCls = 'neg'; }
    const eng = $('engineStatus');
    eng.textContent = st;
    eng.className = 'stat-main ' + stCls;
    eng.style.fontSize = '1.05rem';
    if (s.cooldownUntil > s.serverTime) $('lastPnlSub').innerHTML = `cooldown ${Math.ceil((s.cooldownUntil - s.serverTime) / 1000)}s (anti-revenge)`;
    else $('lastPnlSub').textContent = 'last trade: ' + (s.lastPnl ? AI2.fmtUsd(s.lastPnl) : '—');
    $('baseMargin').textContent = AI2.fmtUsd(s.baseMargin);
    if (s.haltReason) AI2.toast('Risk halt: ' + s.haltReason, 'err');

    // balance
    const b = s.balance;
    if (b && b.equity != null) {
      $('balanceMain').textContent = AI2.fmtUsd(b.equity);
      $('balanceMain').className = 'stat-main';
      $('balanceSub').innerHTML = `available <b>${AI2.fmtUsd(b.available)}</b> · in positions <b>${AI2.fmtUsd(b.positionMargin)}</b> · unrealized <b class="${AI2.clsPnl(b.unrealized)}">${AI2.fmtUsd(b.unrealized)}</b>`;
    } else if (b && b.error) {
      $('balanceMain').textContent = '—';
      $('balanceSub').innerHTML = `<span class="neg">API: ${escapeHtml(b.error).slice(0, 60)}</span>`;
    } else {
      $('balanceMain').textContent = '—';
      $('balanceSub').textContent = 'waiting for API connection…';
    }

    // season
    if (s.season) {
      const t = Number(s.season.target) || 1;
      const gain = s.balance && s.balance.equity != null ? s.balance.equity - s.season.startBalance : (s.season.realizedPnl || 0);
      $('seasonMain').textContent = AI2.fmtUsd(t, 0);
      $('seasonSub').innerHTML = `started <b>${AI2.fmtUsd(s.season.startBalance)}</b> at ${new Date(s.season.startedAt).toLocaleString()}<br>peak <b>${AI2.fmtUsd(s.season.peakBalance)}</b> · session gain <b class="${AI2.clsPnl(gain)}">${AI2.fmtUsd(gain)}</b>`;
      $('millionTarget').textContent = AI2.fmtUsd(t, 0);
      const pct = Math.max(0, Math.min(100, (s.balance?.equity || 0) / t * 100));
      $('millionFill').style.width = pct.toFixed(2) + '%';
      $('millionPct').textContent = pct.toFixed(pct < 1 ? 3 : 2) + '% reached · ' + AI2.fmtUsd(Math.max(0, t - (s.balance?.equity || 0)), 0) + ' to go';
    }

    // win rate ring
    const w = s.stats;
    $('winMain').textContent = w.wins + w.losses ? w.winRate + '%' : '—';
    $('winSub').innerHTML = `<b class="pos">${w.wins}W</b> / <b class="neg">${w.losses}L</b> · PF ${w.profitFactor}`;
    const C = 163.4;
    $('winRing').style.strokeDashoffset = C - C * (w.winRate / 100);

    // executed
    $('execMain').textContent = w.executedSeason;
    $('execSub').innerHTML = `this season · <b>${w.executedTotal}</b> all time`;

    // today
    $('todayMain').textContent = AI2.fmtUsd(w.todayPnl || 0);
    $('todayMain').className = 'stat-main ' + AI2.clsPnl(w.todayPnl || 0);
    $('todaySub').innerHTML = w.todayHalted
      ? '<span class="neg">⛔ halted — daily drawdown limit</span>'
      : `${s.settings.maxConsecutiveLosses} losses / ${s.settings.dailyDrawdownPct}% DD guard · ${s.stats.consecutiveLosses} streak`;

    // scanner
    const sc = s.scanner;
    if (sc) {
      $('scanMain').textContent = sc.stats.eligible;
      $('scanSub').innerHTML = `coins pass ${AI2.fmtCompact(sc.stats.minVolume)} vol filter · ${sc.stats.scanned} scans · updated ${AI2.timeAgo(sc.stats.lastScan)} ago`;
    }

    // liquid
    if (s.season) {
      const eq = s.balance && s.balance.equity != null ? s.balance.equity : s.season.startBalance;
      const pctChange = s.season.startBalance ? (eq - s.season.startBalance) / s.season.startBalance * 100 : 0;
      const clamped = Math.max(-100, Math.min(100, pctChange));
      const fill = $('liqFill');
      fill.className = 'liquid-fill ' + (clamped >= 0 ? 'profit' : 'loss');
      const half = Math.abs(clamped) / 2; // % of track width
      fill.style.width = half + '%';
      $('liqValue').textContent = (clamped >= 0 ? '+' : '') + clamped.toFixed(2) + '%';
      $('liqValue').className = 'liquid-value ' + AI2.clsPnl(clamped);
      $('liqPnl').textContent = AI2.fmtUsd(s.season.realizedPnl || 0);
      $('liqPnl').className = 'liquid-value ' + AI2.clsPnl(s.season.realizedPnl || 0);
      $('liqWave').style.opacity = clamped === 0 ? 0.15 : 0.5;
    } else {
      $('liqFill').style.width = '0%';
      $('liqValue').textContent = '0.00%';
      $('liqPnl').textContent = '$0.00';
    }

    // positions
    renderPositions(s);

    // completed recent
    const rb = $('recentBody');
    if (!s.completed.length) {
      rb.innerHTML = '<tr><td colspan="7" class="small-dim" style="text-align:center;padding:16px">No completed trades yet.</td></tr>';
    } else {
      rb.innerHTML = s.completed.map((t) => `
        <tr>
          <td class="sym">${escapeHtml(t.symbol)}</td>
          <td><span class="side-chip ${t.side === 'LONG' ? 'long' : 'short'}">${t.side}</span></td>
          <td class="${AI2.clsPnl(t.roi)}">${AI2.fmtPct(t.roi)}</td>
          <td class="${AI2.clsPnl(t.pnl)}" style="font-weight:700">${AI2.fmtUsd(t.pnl)}</td>
          <td class="small-dim">${escapeHtml(t.exitType)}</td>
          <td>${t.aiScore ?? '—'}</td>
          <td class="small-dim">${AI2.timeAgo(t.closedAt)} ago</td>
        </tr>`).join('');
    }

    // feed
    const feedEl = $('feedEl');
    if (s.feed && s.feed.length) {
      feedEl.innerHTML = s.feed.map((f) => `
        <div class="fitem ${feedCls(f.type)}">
          <span class="fts">${AI2.clockTime(f.ts)}</span><span>${escapeHtml(f.msg)}</span>
        </div>`).join('');
      // robot speaks new events (on first load we adopt history silently)
      if (!lastEventTs && s.feed.length) {
        lastEventTs = Math.max(...s.feed.map((f) => f.ts));
      } else {
        const fresh = s.feed.filter((f) => f.ts > lastEventTs);
        for (const f of fresh) TradeMaster.event(f.type, f.msg, f.data || {});
        if (fresh.length) lastEventTs = Math.max(...fresh.map((f) => f.ts));
      }
    }

    // scan log
    const sl = $('scanLogEl');
    if (s.scanLog && s.scanLog.length) {
      sl.innerHTML = s.scanLog.slice(0, 22).map((e) => `
        <div style="display:flex;gap:10px;align-items:center;font-size:.78rem">
          <span class="fts" style="font-family:var(--font-m);font-size:.66rem;color:var(--dim)">${AI2.clockTime(e.ts)}</span>
          <span class="sym" style="min-width:110px">${escapeHtml(e.symbol)}</span>
          ${AI2.aiBarHtml(e.score)}
          <span class="direction-tag ${e.direction}" style="min-width:70px;text-align:center">${e.direction}</span>
          <span class="small-dim" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.tradable ? '✔ PASSED ALL GATES' : e.reason || '')}</span>
          ${e.tradable ? '<span class="side-chip long">GATE OPEN</span>' : ''}
        </div>`).join('');
    }
  }

  function feedCls(t) {
    if (t === 'trade_win') return 'win';
    if (t === 'trade_loss') return 'loss';
    if (t === 'trade_open') return 'open';
    if (t === 'alert') return 'alert';
    if (t === 'session') return 'session';
    return '';
  }

  function renderPositions(s) {
    const body = $('posBody');
    $('posCount').textContent = `${s.positions.length} / ${s.settings.maxOpenTrades} slots`;
    if (!s.positions.length) {
      body.innerHTML = '<tr><td colspan="15" class="small-dim" style="text-align:center;padding:22px">No open positions — the engine will fire when a 70+ AI setup confirms at candle close.</td></tr>';
      return;
    }
    body.innerHTML = s.positions.map((p) => {
      const bd = p.aiBreakdown
        ? Object.entries(p.aiBreakdown).map(([k, v]) => `${k}: ${v}`).join('\n')
        : '';
      const trail = p.trailStatus || '—';
      return `
      <tr class="${p.closing ? 'closing-row' : ''}">
        <td class="small-dim">${p.id}</td>
        <td class="sym">${escapeHtml(p.symbol)}${p.tp1Done ? ' <span class="small-dim" title="TP1 taken">½✓</span>' : ''}</td>
        <td><span class="side-chip ${p.side === 'LONG' ? 'long' : 'short'}">${p.side}</span></td>
        <td title="${escapeHtml(bd)}">${AI2.aiBarHtml(p.aiScore, p.aiClass ? p.aiClass.cls : null)}</td>
        <td>${AI2.fmtUsd(p.margin)}</td>
        <td>${p.leverage}x</td>
        <td>${AI2.fmtPrice(p.entry)}${p.entryKnown ? '' : ' <span class="small-dim">≈</span>'}</td>
        <td>${AI2.fmtPrice(p.mark)}</td>
        <td class="${AI2.clsPnl(p.roi)}" style="font-weight:700">${AI2.fmtPct(p.roi)}</td>
        <td class="${AI2.clsPnl(p.pnl)}" style="font-weight:700">${AI2.fmtUsd(p.pnl)}</td>
        <td class="pos">${AI2.fmtPrice(p.tp2Price || p.tpPrice)}</td>
        <td class="neg">${AI2.fmtPrice(p.slPrice)}</td>
        <td><span class="${p.trail && p.trail.active ? 'trail-ok' : 'trail-wait'}">${escapeHtml(trail)}</span></td>
        <td class="small-dim">${AI2.timeAgo(p.openTime)}</td>
        <td>${p.closing ? '<span class="small-dim">closing…</span>' : `<button class="btn danger xs" data-close="${escapeHtml(p.symbol)}">Close</button>`}</td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-close]').forEach((btn) => {
      btn.onclick = async () => {
        const r = await AI2.api('/api/position/close', 'POST', { symbol: btn.dataset.close });
        AI2.toast(r.ok ? `Closing ${btn.dataset.close}…` : '✘ ' + r.error, r.ok ? 'ok' : 'err');
      };
    });
  }

  function escapeHtml(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    renderCfg();
    $('powerBtn').addEventListener('click', () => {
      if (!STATE) return;
      if (STATE.running) openModal('stop');
      else openModal('start');
    });
    $('gearBtn').addEventListener('click', () => openModal(STATE && STATE.running ? 'settings' : 'start'));
    $('modalCancel').addEventListener('click', closeModal);
    $('modalSave').addEventListener('click', doSave);
    $('modalStartStop').addEventListener('click', () => {
      if (modalMode === 'stop') doStop();
      else if (STATE && STATE.running) doSave();
      else doStart();
    });
    $('modalIpCopy').addEventListener('click', () => AI2.copy($('modalIp').textContent));
    $('modalBack').addEventListener('click', (e) => { if (e.target === $('modalBack')) closeModal(); });
    $('closeAllBtn').addEventListener('click', async () => {
      if (!STATE || !STATE.positions.length) return AI2.toast('No open positions', '');
      const r = await AI2.api('/api/position/closeAll', 'POST', {});
      AI2.toast(r.ok ? `Closing ${r.closing} position(s)…` : '✘ ' + r.error, r.ok ? 'ok' : 'err');
    });
    $('refreshPos').addEventListener('click', async () => {
      const s = await AI2.api('/api/state');
      render(s);
      AI2.toast('Refreshed', 'ok');
    });
    const vb = $('voiceBtn');
    const syncVoice = () => {
      vb.textContent = TradeMaster.muted ? '🔇' : '🔊';
      vb.classList.toggle('muted', TradeMaster.muted);
      $('voiceState').textContent = TradeMaster.muted ? 'voice muted' : 'voice on';
    };
    vb.addEventListener('click', () => {
      // toggle via robot's internal switch
      document.querySelector('#robot .muteswitch')?.click();
      setTimeout(syncVoice, 60);
    });
    setInterval(syncVoice, 800);
  }

  wire();
  AI2.connect(render);
  setInterval(() => { if (STATE) render(STATE); }, 5000); // extra safety refresh every 5s
})();
