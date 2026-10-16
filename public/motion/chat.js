/* Call micro-motion: calm, and never in the way of typing, sending or speaking.
 *
 * Nova's "conversation" is the live discovery call. What moves, and what never does:
 *  - Your answer line (#you-line): when a new answer starts (empty -> text), it enters from the
 *    controls side (y 16 -> 0, fade, 0.25s). Its live updates as you speak are never animated.
 *  - Nova's line (#ai-line) grows word by word while Nova speaks: no per-word or per-character
 *    animation, ever. Only a new line (not a continuation of the last one) fades in, 0.15s.
 *  - The call's end: the "Build my blueprint" row fades in once the call is done.
 *  - The blueprint: tables and the stage flow render complete with one 0.2s fade, and the action
 *    row (download, unlock, consultant) fades in after the document.
 *  - Confirmations: a success toast gets a small check that scales in (back.out), holds 1.2s,
 *    then fades.
 * This file only watches the DOM app.js renders; it never calls into app logic or changes it.
 */
(function () {
  'use strict';
  var M = window.NovaMotion;
  if (!M || !M.gsap) return;
  var gsap = M.gsap;
  var app = document.getElementById('app');
  if (!app) return;

  var lastAi = '';
  var youEmpty = true;
  var stage = document.body.dataset.stage;
  var doneRowSeen = false;
  var blueprintShown = false;

  function onAiLine(el) {
    var t = (el.textContent || '').trim();
    if (t === lastAi) return;
    // A continuation (the line growing as Nova speaks) is left alone; only a new line fades.
    var isNew = lastAi && t.indexOf(lastAi.slice(0, Math.min(lastAi.length, 24))) !== 0;
    lastAi = t;
    if (isNew) M.tween(el, { opacity: 0.15 }, { opacity: 1, duration: M.reduced ? 0.3 : 0.15, ease: 'power1.out', clearProps: 'opacity' });
  }
  function onYouLine(el) {
    var empty = el.classList.contains('empty');
    if (!empty && youEmpty && !M.reduced) {
      M.tween(el, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.25, ease: M.EASE.reveal, clearProps: 'transform,opacity' });
    }
    youEmpty = empty;
  }
  function check() {
    var now = document.body.dataset.stage;
    if (now !== stage) { stage = now; lastAi = ''; youEmpty = true; doneRowSeen = false; if (now !== 'blueprint') blueprintShown = false; }
    var ai = document.getElementById('ai-line');
    if (ai) onAiLine(ai);
    var you = document.getElementById('you-line');
    if (you) onYouLine(you);
    var sb = document.getElementById('structure-btn');
    if (sb && !doneRowSeen) {
      doneRowSeen = true;
      M.fadeIn(sb.closest('.call-row') || sb);
    } else if (!sb) doneRowSeen = false;
    var doc = document.querySelector('#main-content > .doc');
    if (doc && now === 'blueprint' && !blueprintShown) {
      blueprintShown = true;
      M.fadeIn(doc.querySelectorAll('.tbl-wrap, .stage-flow'), { duration: 0.2 });
      var row = doc.nextElementSibling && doc.nextElementSibling.classList.contains('btn-row') ? doc.nextElementSibling : null;
      if (row) M.fadeIn(row, { delay: 0.25 });
    }
  }
  // Microtask timing: runs after app.js has written the DOM and before the browser paints it.
  new MutationObserver(check).observe(app, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  check();

  /* Success toast: a check scales in, holds, fades. Errors get no check. */
  var toast = document.getElementById('toast');
  if (toast) {
    new MutationObserver(function () {
      if (!toast.classList.contains('show') || toast.classList.contains('err') || toast.querySelector('.toast-check')) return;
      var tick = document.createElement('span');
      tick.className = 'toast-check';
      tick.setAttribute('aria-hidden', 'true');
      tick.textContent = '✓';
      toast.insertBefore(tick, toast.firstChild);
      if (M.reduced) return;
      gsap.timeline()
        .fromTo(tick, { scale: 0, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.4, ease: 'back.out(2.2)' })
        .to(tick, { autoAlpha: 0, duration: 0.3, ease: 'power1.out' }, '+=1.2');
    }).observe(toast, { attributes: true, attributeFilter: ['class'], childList: true });
  }
})();
