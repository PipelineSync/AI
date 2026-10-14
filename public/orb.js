/* The call orb: a rotating globe of particles, orange in front and blue behind, that ripples with
   the voice. No dependencies.

   app.js owns the orb element (#orb) and its state classes (listening/live, speaking, thinking,
   complete, error, idle/ready) and re-renders it freely, so this file never caches it: each frame
   it looks up #orb and draws into the <canvas class="orb-globe"> inside. The visitor's real
   microphone level arrives as #orb[data-level] (0..1, written by paintMicLevel in app.js); Nova's
   own voice has no meter, so while speaking the waves follow a syllable rhythm instead.
   Reduced motion draws one still frame per change instead of animating. */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const app = document.getElementById('app');
  if (!app) return;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Points spread evenly over a unit sphere (Fibonacci lattice).
  const N = 520;
  const PTS = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) / N * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996;
    PTS.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const PALETTE = {
    idle:      { front: [255, 122, 26], back: [91, 140, 255], glow: [255, 122, 26] },
    listening: { front: [255, 122, 26], back: [91, 140, 255], glow: [91, 140, 255] },
    speaking:  { front: [255, 140, 50], back: [91, 140, 255], glow: [255, 122, 26] },
    thinking:  { front: [255, 171, 94], back: [91, 140, 255], glow: [255, 171, 94] },
    complete:  { front: [52, 211, 153], back: [63, 208, 238], glow: [52, 211, 153] },
    error:     { front: [248, 113, 113], back: [91, 140, 255], glow: [248, 113, 113] }
  };
  const SPIN = { idle: 0.3, listening: 0.35, speaking: 0.7, thinking: 1.6, complete: 0.45, error: 0.15 };

  function stateOf(orb) {
    const c = ' ' + orb.className + ' ';
    if (c.indexOf(' error ') >= 0) return 'error';
    if (c.indexOf(' complete ') >= 0) return 'complete';
    if (c.indexOf(' speaking ') >= 0) return 'speaking';
    if (c.indexOf(' thinking ') >= 0) return 'thinking';
    if (c.indexOf(' listening ') >= 0 || c.indexOf(' live ') >= 0) return 'listening';
    return 'idle';
  }
  function targetLevel(orb, st, t) {
    if (st === 'listening') {
      const m = parseFloat(orb.getAttribute('data-level'));
      return isNaN(m) ? 0.1 + 0.05 * Math.sin(t * 2) : m;   // no meter: a gentle breath
    }
    if (st === 'speaking') {
      const syl = Math.abs(Math.sin(t * 10.5)) * 0.8 + 0.2;
      return syl * (Math.sin(t * 1.4) > -0.5 ? 1 : 0.15);
    }
    if (st === 'thinking') return 0;
    if (st === 'complete') return 0.12 + 0.06 * Math.sin(t * 3);
    return 0.05 + 0.03 * Math.sin(t * 1.6);
  }

  let raf = null, spin = 0, level = 0, last = 0;
  function frame(nowMs) {
    raf = null;
    const orb = document.getElementById('orb');
    const cv = orb && orb.querySelector('canvas.orb-globe');
    if (!cv) { last = 0; return; }   // not on the call screen: stop until the next render
    let g = null;
    try { g = cv.getContext && cv.getContext('2d'); } catch (e) { g = null; }
    if (!g) return;

    const now = (nowMs || 0) / 1000;
    const dt = reduced || !last ? 0 : Math.min(0.05, now - last);
    last = now;
    const t = reduced ? 4.2 : now;
    const st = stateOf(orb);
    const target = reduced ? (st === 'thinking' ? 0 : 0.25) : targetLevel(orb, st, t);
    level += (target - level) * (reduced ? 1 : Math.min(1, dt * 12));
    spin += dt * SPIN[st];

    // Keep the backing store in step with the element's size and the screen's pixel density.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) { if (!reduced) raf = window.requestAnimationFrame(frame); return; }
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const pal = PALETTE[st];
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
    // Soft glow behind the globe, tinted by state.
    const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.45);
    glow.addColorStop(0, 'rgba(' + pal.glow + ',' + (0.16 + level * 0.18).toFixed(3) + ')');
    glow.addColorStop(1, 'rgba(' + pal.glow + ',0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(cx, cy, R * 1.45, 0, Math.PI * 2); g.fill();

    const wave = st === 'thinking' ? 0 : Math.min(1, level) * 0.28;
    const cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(0.35), stl = Math.sin(0.35);
    const dot = Math.max(0.6, R / 70);
    for (let i = 0; i < N; i++) {
      const p = PTS[i];
      const x = p[0] * cs - p[2] * sn;
      let z = p[0] * sn + p[2] * cs;
      const y = p[1] * ct - z * stl;
      z = p[1] * stl + z * ct;
      const d = 1 + wave * Math.sin(p[1] * 7 + t * 6) * Math.cos(p[0] * 5 - t * 3);
      const k = (z + 1) / 2;   // 0 = back, 1 = front
      const c0 = pal.back, c1 = pal.front;
      g.fillStyle = 'rgba(' + Math.round(c0[0] + (c1[0] - c0[0]) * k) + ',' + Math.round(c0[1] + (c1[1] - c0[1]) * k) + ',' +
        Math.round(c0[2] + (c1[2] - c0[2]) * k) + ',' + (0.22 + 0.78 * k).toFixed(3) + ')';
      g.beginPath(); g.arc(cx + x * R * d, cy + y * R * d, dot * (0.6 + 1.5 * k), 0, Math.PI * 2); g.fill();
    }
    if (!reduced) raf = window.requestAnimationFrame(frame);
  }
  function kick() {
    if (raf == null && window.requestAnimationFrame) raf = window.requestAnimationFrame(frame);
  }
  // Start (or redraw, under reduced motion) whenever the app re-renders or the orb changes state.
  new MutationObserver(kick).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  kick();
})();
