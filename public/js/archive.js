'use strict';
/* Archive page — full completed-position history + season archive with performance sparklines. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let DATA = { completed: [], sessions: [] };
  let page = 0;
  const PER = 50;

  async function load() {
    DATA = await AI2.api('/api/archive');
    renderStats();
    renderSessions();
    renderTable();
    AI2.api('/api/state').then((s) => AI2.bindHeader(s)).catch(() => {}); // keep ping/IP chips live
  }

  function renderStats() {
    const st = DATA.stats || {};
    const total = DATA.completed.length;
    $('arTotal').textContent = total;
    $('arTotalSub').textContent = `${st.executedSeason || 0} this season`;
    $('arWin').textContent = (st.wins + st.losses) ? st.winRate + '%' : '—';
    $('arWinSub').innerHTML = `<b class="pos">${st.wins || 0}W</b> / <b class="neg">${st.losses || 0}L</b> · PF ${st.profitFactor || '—'}`;
    const pnl = DATA.completed.reduce((s, t) => s + (t.pnl || 0), 0);
    $('arPnl').textContent = AI2.fmtUsd(pnl);
    $('arPnl').className = 'stat-main ' + AI2.clsPnl(pnl);
    $('arPnlSub').textContent = 'realized, all seasons';
    const best = DATA.completed.reduce((a, t) => (t.pnl > (a?.pnl ?? -1e18) ? t : a), null);
    const worst = DATA.completed.reduce((a, t) => (t.pnl < (a?.pnl ?? 1e18) ? t : a), null);
    $('arBest').textContent = best ? `${AI2.fmtUsd(best.pnl)} ${best.symbol}` : '—';
    $('arBest').className = 'stat-main ' + (best ? (best.pnl >= 0 ? 'pos' : 'neg') : '');
    $('arWorst').textContent = worst ? `worst ${AI2.fmtUsd(worst.pnl)} ${worst.symbol}` : '—';
  }

  /* sparkline on canvas: cumulative profit over trades */
  function sparkline(canvas, series, positive) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    const H = canvas.height = 64 * (window.devicePixelRatio || 1);
    canvas.style.height = '64px';
    ctx.clearRect(0, 0, W, H);
    // baseline grid
    ctx.strokeStyle = 'rgba(0,229,255,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    if (!series.length) return;
    let min = Math.min(...series, 0), max = Math.max(...series, 0);
    if (max === min) max = min + 1;
    const x = (i) => series.length === 1 ? W / 2 : (i / (series.length - 1)) * (W - 8) + 4;
    const y = (v) => H - 8 - ((v - min) / (max - min)) * (H - 16);
    const col = positive ? '#00ff9d' : '#ff3b5c';
    // area
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, positive ? 'rgba(0,255,157,.35)' : 'rgba(255,59,92,.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(x(0), y(series[0]));
    series.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(series.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // line
    ctx.beginPath();
    ctx.moveTo(x(0), y(series[0]));
    series.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.shadowColor = col; ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // zero line label
    ctx.fillStyle = 'rgba(160,190,230,.7)';
    ctx.font = `${10 * (window.devicePixelRatio || 1)}px monospace`;
  }

  function renderSessions() {
    const grid = $('sessGrid');
    if (!DATA.sessions || !DATA.sessions.length) {
      grid.innerHTML = '<div class="card small-dim" style="padding:16px">No seasons archived yet — start & stop the engine to archive a season.</div>';
      return;
    }
    grid.innerHTML = DATA.sessions.map((se, idx) => {
      const pos = se.pnl >= 0;
      return `
      <div class="sess-card">
        <h4>${esc(se.id)} <span class="${pos ? 'pos' : 'neg'}" style="float:right">${AI2.fmtUsd(se.pnl)}</span></h4>
        <canvas class="spark" data-idx="${idx}" style="width:100%"></canvas>
        <div class="sess-meta">
          <span>start <b>${AI2.fmtUsd(se.startBalance)}</b></span>
          <span>end <b>${AI2.fmtUsd(se.endBalance)}</b></span>
          <span>trades <b>${se.trades}</b></span>
          <span>W/L <b>${se.wins || 0}/${se.losses || 0}</b></span>
          <span>started <b>${new Date(se.startedAt).toLocaleString()}</b></span>
          <span>duration <b>${durH(se.startedAt, se.endedAt)}</b></span>
        </div>
      </div>`;
    }).join('');
    // draw sparklines after DOM insert
    DATA.sessions.forEach((se, idx) => {
      const canvas = grid.querySelector(`canvas[data-idx="${idx}"]`);
      if (canvas) requestAnimationFrame(() => sparkline(canvas, se.sparkline || [0], (se.pnl || 0) >= 0));
    });
  }

  function durH(a, b) {
    const m = Math.max(1, Math.round((b - a) / 60000));
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h';
  }

  function filtered() {
    const fs = $('filterSide').value, fe = $('filterExit').value;
    return DATA.completed.filter((t) => (!fs || t.side === fs) && (!fe || t.exitType === fe));
  }

  function renderTable() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PER));
    page = Math.min(page, pages - 1);
    const slice = list.slice(page * PER, page * PER + PER);
    $('shownCount').textContent = list.length + ' shown';
    $('pageInfo').textContent = `PAGE ${page + 1} / ${pages}`;
    const body = $('archBody');
    if (!slice.length) {
      body.innerHTML = '<tr><td colspan="15" class="small-dim" style="text-align:center;padding:26px">No trades match this filter.</td></tr>';
      return;
    }
    body.innerHTML = slice.map((t) => `
      <tr>
        <td class="small-dim">${t.id}</td>
        <td class="small-dim">${esc(t.season || '—')}</td>
        <td class="sym">${esc(t.symbol)}</td>
        <td><span class="side-chip ${t.side === 'LONG' ? 'long' : 'short'}">${t.side}</span></td>
        <td class="small-dim">${t.strategy === 'scalp_3m' ? '3M SCALP' : 'OBV×EMA50'}</td>
        <td>${AI2.fmtUsd(t.margin)}</td>
        <td>${t.leverage}x</td>
        <td>${AI2.fmtPrice(t.entry)}</td>
        <td>${AI2.fmtPrice(t.exit)}</td>
        <td class="${AI2.clsPnl(t.roi)}" style="font-weight:600">${AI2.fmtPct(t.roi)}</td>
        <td class="${AI2.clsPnl(t.pnl)}" style="font-weight:700">${AI2.fmtUsd(t.pnl)}</td>
        <td>${t.aiScore ?? '—'}</td>
        <td class="small-dim" style="max-width:260px;overflow:hidden;text-overflow:ellipsis" title="${esc(t.reason)}">${esc(t.exitType)} — ${esc(t.reason || '')}</td>
        <td class="small-dim">${Math.floor(t.holdSec / 60)}m ${t.holdSec % 60}s</td>
        <td class="small-dim">${new Date(t.closedAt).toLocaleString()}</td>
      </tr>`).join('');
  }

  $('prevPage').addEventListener('click', () => { if (page > 0) { page--; renderTable(); } });
  $('nextPage').addEventListener('click', () => { page++; renderTable(); });
  $('filterSide').addEventListener('change', () => { page = 0; renderTable(); });
  $('filterExit').addEventListener('change', () => { page = 0; renderTable(); });
  const vb = $('voiceBtn');
  setInterval(() => { vb.textContent = TradeMaster.muted ? '🔇' : '🔊'; vb.classList.toggle('muted', TradeMaster.muted); }, 800);
  vb.addEventListener('click', () => { document.querySelector('#robot .muteswitch')?.click(); });

  load();
  setInterval(load, 8000); // archive refreshes as trades close
})();
