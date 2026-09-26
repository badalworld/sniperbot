'use strict';
/* Shared helpers: live SSE stream (1s updates, auto-reconnect), formatters, toasts, copy. */
const AI2 = {};

AI2.fmtUsd = (v, d) => {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const dec = d != null ? d : (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
AI2.fmtNum = (v, d) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }));
AI2.fmtPct = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d) + '%');
AI2.fmtCompact = (v) => {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
};
AI2.fmtPrice = (v) => {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
};
AI2.clsPnl = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu');
AI2.sig = (v) => (v > 0 ? '+' : '') + v;

AI2.timeAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd';
};
AI2.clockTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

/* toast */
AI2.toast = (msg, type) => {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, 4200);
};

AI2.copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    AI2.toast('Copied ✓ ' + text, 'ok');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); AI2.toast('Copied ✓ ' + text, 'ok'); } catch (e2) { AI2.toast('Copy failed — select manually', 'err'); }
    ta.remove();
  }
};

/* live stream: SSE with 5s polling fallback */
AI2.connect = (onSnapshot) => {
  let lastTs = 0;
  const apply = (data) => { if (data && data.serverTime) lastTs = data.serverTime; onSnapshot(data); };

  const startPolling = () => {
    if (AI2._polling) return;
    AI2._polling = setInterval(async () => {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        apply(await r.json());
      } catch (e) { /* server offline */ }
    }, 5000);
  };

  const openSSE = () => {
    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('snapshot', (ev) => { try { apply(JSON.parse(ev.data)); } catch (e) {} });
      es.onopen = () => { if (AI2._polling) { clearInterval(AI2._polling); AI2._polling = null; } };
      es.onerror = () => { es.close(); setTimeout(openSSE, 3000); startPolling(); };
    } catch (e) { startPolling(); }
  };
  openSSE();
};

/* api helper */
AI2.api = async (path, method, body) => {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  return j;
};

/* AI score bar HTML */
AI2.aiBarHtml = (score, cls) => {
  const s = Math.max(0, Math.min(100, score || 0));
  const c = cls || (s >= 90 ? 'elite' : s >= 80 ? 'strong' : s >= 70 ? 'good' : s >= 60 ? 'moderate' : s >= 40 ? 'weak' : 'veryweak');
  return `<div class="aiwrap"><div class="aibar"><i class="cls-${c}" style="width:${s}%"></i></div><span class="ai-num ai-${c}">${s == null ? '—' : s}</span></div>`;
};

/* shared header bindings: ping, ip, voice */
AI2.bindHeader = (state) => {
  const ping = document.getElementById('pingChip');
  if (ping && state.ping) {
    const ms = state.ping.ms;
    ping.classList.toggle('ping-ok', ms != null && ms < 100);
    ping.classList.toggle('ping-bad', ms == null || ms >= 100);
    ping.innerHTML = `<span class="lbl">PING</span> ${ms == null ? '…' : ms}<span style="opacity:.7">ms</span>`;
  }
  const ipChip = document.getElementById('ipChip');
  if (ipChip && state.ip) {
    const ip = state.ip.public || state.ip.lan?.[0] || '…';
    ipChip.innerHTML = `<span class="lbl">IP</span><span class="ip-val">${ip}</span><span class="cpy" title="Click to copy" style="cursor:pointer">📋</span>`;
    ipChip.querySelector('.cpy').onclick = () => AI2.copy(ip);
    ipChip.onclick = (ev) => { if (ev.target === ipChip) AI2.copy(ip); };
  }
  const live = document.getElementById('liveBadge');
  if (live) {
    live.textContent = state.running ? '● LIVE' : '○ STANDBY';
    live.classList.toggle('stopped', !state.running);
  }
};
