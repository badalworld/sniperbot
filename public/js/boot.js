'use strict';
/* Cinematic boot sequence overlay — types the AI core init lines, then fades away. */
(() => {
  const box = document.getElementById('boot');
  if (!box) return;
  const lines = [
    '> INITIALIZING AI CORE v2.1 ........ OK',
    '> LINKING MEXC FUTURES API ......... OK',
    '> LOADING STRATEGY MATRIX .......... OK',
    '> CALIBRATING COMPOUNDING ENGINE ... OK',
    '> TRADE MASTER ONLINE .............. OK',
  ];
  const el = document.getElementById('bootLines');
  const fill = document.getElementById('bootFill');
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    box.classList.add('done');
    setTimeout(() => box.remove(), 750);
  }
  let i = 0, txt = '';
  (function type() {
    if (i < lines.length) {
      txt += lines[i] + '\n';
      i++;
      if (el) el.textContent = txt;
      if (fill) fill.style.width = (i / lines.length) * 100 + '%';
      setTimeout(type, 165);
    } else setTimeout(finish, 340);
  })();
  setTimeout(finish, 4200); // failsafe — never trap the user
  window.BOOT_DONE = finish;
})();
