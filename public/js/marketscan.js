'use strict';
/* Market Scanner page — rolling 40 rows, live 1s updates, entry animations. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      body.innerHTML = '<tr><td colspan="12" class="small-dim" style="text-align:center;padding:28px">Scanner warming up — first rows appear within seconds…</td></tr>';
      return;
    }

    body.innerHTML = sc.rows.map((r, i) => {
      const isNew = !prevSymbols.has(r.symbol) && prevSymbols.size > 0;
      const biasPct = Math.min(100, Math.round((r.quickScore || 0)));
      const biasCls = biasPct >= 70 ? 'cls-strong' : biasPct >= 45 ? 'cls-good' : biasPct >= 25 ? 'cls-moderate' : 'cls-weak';
      return `
      <tr data-sym="${esc(r.symbol)}" class="${isNew ? 'rowin' : ''}">
        <td class="small-dim">${i + 1}</td>
        <td class="sym">${esc(r.symbol)}${r.isNew ? ' <span class="side-chip long" style="font-size:.5rem">NEW</span>' : ''}</td>
        <td>${AI2.fmtPrice(r.price)}</td>
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
  }

  AI2.connect(render);
  setInterval(() => AI2.api('/api/state').then(render).catch(() => {}), 5000);
})();
