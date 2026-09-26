'use strict';
/* Market Scanner page — rolling 40 rows, live 1s updates, entry animations, price flashes, trend sparklines. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const prevPrice = new Map();

  function miniSpark(cv, arr, direction) {
    const ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.width = 92 * dpr, H = cv.height = 26 * dpr;
    ctx.clearRect(0, 0, W, H);
    if (!arr || arr.length < 2) return;
    const min = Math.min(...arr), max = Math.max(...arr);
    const span = max - min || 1;
    const X = (i) => 2 * dpr + i / (arr.length - 1) * (W - 4 * dpr);
    const Y = (v) => H - 3 * dpr - ((v - min) / span) * (H - 6 * dpr);
    const col = direction === 'LONG' ? '#00ff9d' : direction === 'SHORT' ? '#ff3b5c' : '#5f7396';
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, direction === 'LONG' ? 'rgba(0,255,157,.30)' : 'rgba(255,59,92,.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.moveTo(X(0), H - 2 * dpr);
    arr.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(arr.length - 1), H - 2 * dpr); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    arr.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = col; ctx.lineWidth = 1.6 * dpr;
    ctx.shadowColor = col; ctx.shadowBlur = 6 * dpr;
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(X(arr.length - 1), Y(arr[arr.length - 1]), 2.2 * dpr, 0, 7);
    ctx.fillStyle = col; ctx.fill();
  }

  function render(s) {
    AI2.bindHeader(s);
    const sc = s.scanner;
    if (!sc) return;
    $('uniCount').textContent = sc.stats.universe;
    $('passCount').textContent = sc.stats.eligible;
    $('minVol').textContent = AI2.fmtCompact(sc.stats.minVolume);
    $('scanMeta').textContent = `last sweep ${AI2.timeAgo(sc.stats.lastScan)} ago · ${sc.stats.cycles} cycles · rotating every second`;
    $('scanStatus').textContent = sc.rows.length ? 'SCANNING & UPDATING LIVE…' : 'SEARCHING MARKETS…';

    const body = $('scanBody');
    const prevSymbols = new Set(Array.from(body.querySelectorAll('tr')).map((tr) => tr.dataset.sym));
    $('rowCount').textContent = sc.rows.length + '/40';

    if (!sc.rows.length) {
      body.innerHTML = '<tr><td colspan="13" class="small-dim" style="text-align:center;padding:28px">Scanner warming up — first rows appear within seconds…</td></tr>';
      return;
    }

    body.innerHTML = sc.rows.map((r, i) => {
      const isNew = !prevSymbols.has(r.symbol) && prevSymbols.size > 0;
      const was = prevPrice.get(r.symbol);
      let flash = '';
      if (was != null && r.price !== was) flash = r.price > was ? 'flash-up' : 'flash-down';
      prevPrice.set(r.symbol, r.price);
      const biasPct = Math.min(100, Math.round((r.quickScore || 0)));
      const biasCls = biasPct >= 70 ? 'cls-strong' : biasPct >= 45 ? 'cls-good' : biasPct >= 25 ? 'cls-moderate' : 'cls-weak';
      return `
      <tr data-sym="${esc(r.symbol)}" class="${isNew ? 'rowin' : ''} ${flash}">
        <td class="small-dim">${i + 1}</td>
        <td class="sym">${esc(r.symbol)}${r.isNew ? ' <span class="side-chip long" style="font-size:.5rem">NEW</span>' : ''}</td>
        <td>${AI2.fmtPrice(r.price)}</td>
        <td><canvas class="mspark" data-sym="${esc(r.symbol)}" style="width:92px;height:26px"></canvas></td>
        <td>${r.mcap ? AI2.fmtCompact(r.mcap) : '<span class="small-dim">—</span>'}</td>
        <td>${AI2.fmtCompact(r.vol24h)}</td>
        <td class="${AI2.clsPnl(r.change24h)}" style="font-weight:600">${AI2.fmtPct(r.change24h)}</td>
        <td class="${AI2.clsPnl(r.change15m)}" style="font-weight:600">${AI2.fmtPct(r.change15m)}</td>
        <td><div class="aiwrap"><div class="aibar"><i class="${biasCls}" style="width:${biasPct}%"></i></div><span class="ai-num">${biasPct}</span></div></td>
        <td><span class="direction-tag ${r.direction}">${r.direction}</span></td>
        <td class="${Math.abs(r.fundingRate) > 0.001 ? 'neg' : 'small-dim'}">${(r.fundingRate * 100).toFixed(4)}%</td>
        <td class="small-dim">${r.oiValue ? AI2.fmtCompact(r.oiValue) : '—'}</td>
        <td class="small-dim">${AI2.timeAgo(r.scannedAt)} ago</td>
      </tr>`;
    }).join('');

    // draw sparklines after the DOM nodes exist
    requestAnimationFrame(() => {
      body.querySelectorAll('canvas.mspark').forEach((cv) => {
        const r = sc.rows.find((x) => x.symbol === cv.dataset.sym);
        if (r) miniSpark(cv, r.spark, r.direction);
      });
    });
  }

  AI2.connect(render);
  setInterval(() => AI2.api('/api/state').then(render).catch(() => {}), 5000);
})();
