/* Glow cursor (fine pointers only, never touch, off with reduced motion).
 *
 * The arrow becomes a soft, diffuse glow: a 140px circle, Nova's orange at about 30% in the
 * centre, transparent by 72%, blur(6px). It follows the pointer with a short lerp (0.28 per
 * frame) and scales to 0.8 while the button is down.
 *
 * Where it shows is decided by CSS (styles.css, "Glow cursor"): html.glow-on sets cursor:none
 * on the page, and gives clickables the pointer and readable text (inputs, the call subtitles,
 * the blueprint, the Terms text) the text cursor. The glow is visible only where the computed
 * cursor is "none", so it fades over anything clickable or selectable and over embedded frames.
 */
(function () {
  'use strict';
  var M = window.NovaMotion;
  if (!M || !M.gsap || M.reduced || !M.finePointer) return;
  var gsap = M.gsap;
  var html = document.documentElement;
  var glow = document.createElement('div');
  glow.className = 'glow-cursor';
  glow.setAttribute('aria-hidden', 'true');
  document.body.appendChild(glow);
  html.classList.add('glow-on');

  var x = -200, y = -200, tx = -200, ty = -200, raf = null, shown = false, lastTarget = null;
  var setX = gsap.quickSetter(glow, 'x', 'px');
  var setY = gsap.quickSetter(glow, 'y', 'px');
  gsap.set(glow, { autoAlpha: 0, scale: 1 });

  function loop() {
    x += (tx - x) * 0.28;
    y += (ty - y) * 0.28;
    setX(x); setY(y);
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? window.requestAnimationFrame(loop) : null;
  }
  function visible(on) {
    if (on === shown) return;
    shown = on;
    gsap.to(glow, { autoAlpha: on ? 1 : 0, duration: 0.2, ease: 'power1.out' });
  }
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') { visible(false); return; }
    tx = e.clientX; ty = e.clientY;
    if (!shown && x < -100) { x = tx; y = ty; setX(x); setY(y); }   // first move: start under the pointer
    if (e.target !== lastTarget) {
      lastTarget = e.target;
      var cur = 'auto';
      try { cur = window.getComputedStyle(e.target).cursor; } catch (err) {}
      visible(cur === 'none');
    }
    if (!raf) raf = window.requestAnimationFrame(loop);
  }, { passive: true });
  document.addEventListener('pointerdown', function () { gsap.to(glow, { scale: 0.8, duration: 0.2, ease: 'power2.out' }); }, { passive: true });
  document.addEventListener('pointerup', function () { gsap.to(glow, { scale: 1, duration: 0.35, ease: M.EASE.roll }); }, { passive: true });
  document.documentElement.addEventListener('mouseleave', function () { visible(false); lastTarget = null; });
  window.addEventListener('blur', function () { visible(false); lastTarget = null; });
  // The page under a still pointer can change (a re-render): re-check on the next move.
  var app = document.getElementById('app');
  if (app) new MutationObserver(function () { lastTarget = null; }).observe(app, { childList: true });
})();
