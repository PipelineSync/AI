/* PipelineSync theme motion: pointer spotlight on tiles and scroll reveal. No dependencies.
   (Headline letter-rolls, the intro and transitions live in public/motion/.) app.js re-renders #app with
   innerHTML, so this watches #app and re-applies after each render.
   Reduced motion turns all of it off. Reveal is only armed when IntersectionObserver
   exists, and print / reduced motion force everything visible in CSS. */
(function () {
  if (typeof window === 'undefined' || !document.getElementById('app')) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const TILES = '.gap-card, .change-card, .stat, .priority-action';
  const REVEAL = TILES + ', .review-group, .coa-item, .doc h3.sec, .success-card, .unlock-panel, .compliance-flag';

  // Pointer-following spotlight: the CSS reads --mx/--my.
  if (finePointer && !reduced) {
    document.addEventListener('pointermove', e => {
      const el = e.target.closest && e.target.closest(TILES);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  if (reduced) return;

  // Scroll reveal. Each stage animates once; re-renders within a stage show the final state.
  const canReveal = 'IntersectionObserver' in window;
  let io = null;
  let revealedStage = null;
  if (canReveal) {
    document.documentElement.classList.add('rv-armed');
    io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    // A fast fling can carry an element past the viewport between frames without it ever
    // intersecting; reveal anything that is already above the fold.
    let ticking = false;
    document.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        document.querySelectorAll('.rv:not(.in)').forEach(el => {
          if (el.getBoundingClientRect().top < window.innerHeight) { el.classList.add('in'); io.unobserve(el); }
        });
      });
    }, { capture: true, passive: true });
  }
  function reveal() {
    if (!io) return;
    const stage = document.body.dataset.stage || '';
    const els = document.querySelectorAll(REVEAL);
    if (stage === revealedStage) { els.forEach(el => el.classList.add('rv', 'in')); return; }
    revealedStage = stage;
    els.forEach(el => {
      const sibs = el.parentElement ? [...el.parentElement.children].filter(c => c.matches(REVEAL)) : [];
      el.style.setProperty('--rv-d', Math.min(Math.max(sibs.indexOf(el), 0), 6) * 80 + 'ms');
      el.classList.add('rv');
      io.observe(el);
    });
  }

  function onRender() { reveal(); }
  new MutationObserver(onRender).observe(document.getElementById('app'), { childList: true });
  onRender();
})();
