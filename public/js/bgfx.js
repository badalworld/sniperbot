'use strict';
/* Animated neural-network background (canvas, GPU-light, pauses when tab hidden). */
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.id = 'bgfx';
  document.body.prepend(c);
  const ctx = c.getContext('2d');
  let W = 0, H = 0, P = [];
  function resize() {
    W = c.width = window.innerWidth;
    H = c.height = window.innerHeight;
    const n = Math.min(70, Math.max(28, Math.floor(W / 24)));
    P = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.34, vy: (Math.random() - 0.5) * 0.34,
      r: Math.random() * 1.5 + 0.6, m: Math.random() < 0.14,
    }));
  }
  window.addEventListener('resize', resize);
  resize();
  const LINK = 132;
  function step() {
    ctx.clearRect(0, 0, W, H);
    for (const p of P) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      for (let j = i + 1; j < P.length; j++) {
        const b = P[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          const o = (1 - Math.sqrt(d2) / LINK) * ((a.m || b.m) ? 0.26 : 0.12);
          ctx.strokeStyle = `rgba(0,229,255,${o})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.fillStyle = a.m ? 'rgba(255,43,214,.85)' : 'rgba(0,229,255,.7)';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 7); ctx.fill();
    }
    if (!document.hidden) requestAnimationFrame(step);
    else setTimeout(step, 900);
  }
  step();
})();
