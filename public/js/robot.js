'use strict';
/* TradeMaster — the animated robot assistant.
 * Floats bottom-right, speaks every action via speechSynthesis, bubble text with typewriter effect. */
const TradeMaster = (() => {
  let muted = localStorage.getItem('tm_muted') === '1';
  let voice = null;
  let queue = [];
  let speaking = false;
  let lastSpeak = 0;
  let bubbleTimer = null, typeTimer = null;
  let root, bubbleEl, bubbleTextEl;

  const PHRASES = {
    trade_open: (d, m) => [`New trade open. Congratulations! ${d.symbol} ${d.side === 'LONG' ? 'long' : 'short'}. Margin ${d.margin} dollars, A I score ${d.aiScore} percent.`, `Opening a ${d.side === 'LONG' ? 'long' : 'short'} position on ${d.symbol}. A I confidence ${d.aiScore} percent. Good luck to us!`],
    trade_win: (d, m) => [`Excellent! ${d.symbol} made profit ${Math.abs(d.pnl).toFixed(2)} dollars. Compounding increased.`, `We are winning! ${d.symbol} closed with ${Math.abs(d.pnl).toFixed(2)} dollars profit.`],
    trade_loss: (d, m) => [`Sorry, we lost this pair. ${d.symbol}, ${Math.abs(d.pnl).toFixed(2)} dollars down. Margin adjusted, we stay strong.`, `Loss on ${d.symbol}. ${Math.abs(d.pnl).toFixed(2)} dollars. Do not worry, the strategy compounds back.`],
    trade_info: (d, m) => [m],
    session: (d, m) => [m],
    alert: (d, m) => [m],
    elite: (d) => [`Elite setup detected on ${d.symbol}. Score ${d.score} percent. This one is special.`],
    scan: (d) => [`Scanning the market. ${d.count} coins pass the volume filter.`],
  };

  function pickVoice() {
    try {
      const vs = speechSynthesis.getVoices();
      if (!vs.length) return;
      const prefer = ['Google US English', 'Microsoft Aria', 'Microsoft Zira', 'Samantha', 'Google UK English Female'];
      for (const p of prefer) { const v = vs.find((x) => x.name.includes(p)); if (v) { voice = v; return; } }
      voice = vs.find((v) => v.lang.startsWith('en')) || vs[0];
    } catch (e) {}
  }

  function speak(text) {
    if (muted) return;
    const now = Date.now();
    if (now - lastSpeak < 1200) { queue.push(text); return; }
    lastSpeak = now;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.rate = 1.02; u.pitch = 1.12; u.volume = 0.95;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  function pump() {
    if (speaking || !queue.length) return;
    speaking = true;
    const text = queue.shift();
    say(text);
    setTimeout(() => { speaking = false; pump(); }, Math.min(9000, 1600 + text.length * 55));
  }

  function say(text) {
    if (!bubbleEl) return;
    bubbleEl.classList.add('show');
    bubbleTextEl.textContent = '';
    clearInterval(typeTimer);
    let i = 0;
    typeTimer = setInterval(() => {
      bubbleTextEl.textContent = text.slice(0, ++i);
      if (i >= text.length) clearInterval(typeTimer);
    }, 14);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), Math.min(11000, 3000 + text.length * 50));
  }

  function moodFor(type) {
    if (type === 'trade_win') return 'happy';
    if (type === 'trade_loss') return 'sad';
    if (type === 'scan' || type === 'trade_open') return 'scanning';
    return null;
  }

  function flash(cls) {
    if (!root) return;
    if (!cls) return;
    root.classList.remove('happy', 'sad', 'scanning');
    void root.offsetWidth;
    root.classList.add(cls);
    if (cls === 'happy' || cls === 'sad') setTimeout(() => root.classList.remove(cls), 1400);
  }

  function build() {
    root = document.createElement('div');
    root.id = 'robot';
    root.innerHTML = `
      <div class="bubble"><span class="who">TRADE MASTER</span><span class="txt"></span></div>
      <div class="botbody" title="TradeMaster — your AI trading robot">
        <div class="halo"></div>
        <svg width="104" height="112" viewBox="0 0 104 112" fill="none">
          <defs>
            <linearGradient id="tmBody" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#0e3a5c"/><stop offset="1" stop-color="#071c30"/>
            </linearGradient>
            <linearGradient id="tmVisor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#01202e"/><stop offset="1" stop-color="#001318"/>
            </linearGradient>
          </defs>
          <line x1="52" y1="6" x2="52" y2="16" stroke="#00e5ff" stroke-width="2"/>
          <circle cx="52" cy="5" r="3.4" fill="#00e5ff">
            <animate attributeName="opacity" values="1;.25;1" dur="1.6s" repeatCount="indefinite"/>
          </circle>
          <rect x="20" y="16" width="64" height="44" rx="14" fill="url(#tmBody)" stroke="#00e5ff" stroke-width="1.6"/>
          <rect x="27" y="24" width="50" height="28" rx="9" fill="url(#tmVisor)" stroke="#0af" stroke-width="1"/>
          <circle class="eyeL" cx="42" cy="38" r="5" fill="#00ff9d">
            <animate attributeName="r" values="5;5;1;5" dur="4s" repeatCount="indefinite" keyTimes="0;.9;.94;1"/>
          </circle>
          <circle class="eyeR" cx="62" cy="38" r="5" fill="#00ff9d">
            <animate attributeName="r" values="5;5;1;5" dur="4s" repeatCount="indefinite" keyTimes="0;.9;.94;1"/>
          </circle>
          <rect x="30" y="66" width="44" height="30" rx="10" fill="url(#tmBody)" stroke="#00e5ff" stroke-width="1.4"/>
          <circle cx="52" cy="81" r="7.5" fill="none" stroke="#ff2bd6" stroke-width="1.6">
            <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite"/>
          </circle>
          <circle cx="52" cy="81" r="2.6" fill="#ff2bd6"/>
          <rect x="10" y="70" width="9" height="22" rx="4.5" fill="#0e3a5c" stroke="#00e5ff" stroke-width="1.2"/>
          <rect x="85" y="70" width="9" height="22" rx="4.5" fill="#0e3a5c" stroke="#00e5ff" stroke-width="1.2"/>
          <rect x="34" y="98" width="12" height="10" rx="4" fill="#0e3a5c" stroke="#00e5ff" stroke-width="1.2"/>
          <rect x="58" y="98" width="12" height="10" rx="4" fill="#0e3a5c" stroke="#00e5ff" stroke-width="1.2"/>
        </svg>
      </div>
      <div class="muteswitch">${muted ? '🔇 VOICE OFF' : '🔊 VOICE ON'}</div>`;
    document.body.appendChild(root);
    bubbleEl = root.querySelector('.bubble');
    bubbleTextEl = bubbleEl.querySelector('.txt');
    root.querySelector('.botbody').addEventListener('click', () => {
      muted = !muted;
      localStorage.setItem('tm_muted', muted ? '1' : '0');
      root.querySelector('.muteswitch').textContent = muted ? '🔇 VOICE OFF' : '🔊 VOICE ON';
      if (muted) { try { speechSynthesis.cancel(); } catch (e) {} }
      else say('Voice enabled. Trade Master online and watching the market.');
    });
    root.querySelector('.muteswitch').addEventListener('click', (e) => {
      e.stopPropagation();
      muted = !muted;
      localStorage.setItem('tm_muted', muted ? '1' : '0');
      root.querySelector('.muteswitch').textContent = muted ? '🔇 VOICE OFF' : '🔊 VOICE ON';
    });
    try { speechSynthesis.onvoiceschanged = pickVoice; pickVoice(); } catch (e) {}
    say('Trade Master online. I will report every trade action for you.');
    speak('Trade Master online. I will report every trade action for you.');
  }

  function event(type, msg, data) {
    if (!root) build();
    const m = moodFor(type);
    flash(m);
    let line = msg;
    const tpl = PHRASES[type];
    if (tpl && data) {
      const opts = tpl(data, msg);
      line = opts[Math.floor(Math.random() * opts.length)];
    }
    queue.push(line);
    pump();
    speak(line);
  }

  function idle(text) {
    if (!root) build();
    say(text);
    speak(text);
  }

  return { event, idle, build, get muted() { return muted; } };
})();
