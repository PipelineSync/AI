/* Page and stage transitions.
 *
 * Real page loads (the entry gate <-> Terms, the dev outbox): a full-screen panel in the app
 * background colour wipes up (yPercent 100 -> 0, 0.45s, power4.inOut), the browser navigates,
 * and on the new page the panel continues up (0 -> -100, 0.5s) while the title letter-rolls.
 *
 * Journey stages inside the app (sign-in, consent, the call, building, the blueprint, booking,
 * done): app.js swaps the screen itself, and this file never delays that - no state, timing or
 * API logic is touched. A MutationObserver runs after the swap but before the browser paints,
 * so the panel is already covering when the new screen first shows; it then slides away
 * (0.5s) and the new title rolls in. Stages inside the build phase (structuring, the missing-
 * figure card, building, the blueprint) cross-fade (0.2s) instead, like switching threads.
 *
 * Skipped for anchors, new tabs, modifier-key clicks and downloads. Reduced motion: no wipes,
 * a 0.3s fade.
 */
(function () {
  'use strict';
  var M = window.NovaMotion;
  if (!M) return;
  var gsap = M.gsap;
  var html = document.documentElement;
  var panel = document.createElement('div');
  panel.className = 'wipe-panel';
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);
  var hidePanel = function () {
    if (gsap) gsap.set(panel, { yPercent: 100, autoAlpha: 0 });
    else { panel.style.visibility = 'hidden'; }
  };
  hidePanel();

  /* The panel slides off the top, revealing what is underneath; the title rolls as it goes. */
  function reveal() {
    var title = M.pageTitle();
    if (title) M.prepRoll(title);
    gsap.set(panel, { yPercent: 0, autoAlpha: 1 });
    html.classList.remove('wipe-in');
    var tl = gsap.timeline();
    tl.to(panel, { yPercent: -100, duration: 0.5, ease: M.EASE.wipe })
      .set(panel, { yPercent: 100, autoAlpha: 0 });
    if (title) tl.add(M.rollIn(title), 0.18);
    // Safety: never leave the panel over the page.
    window.setTimeout(function () { if (tl.progress() < 1) tl.progress(1); }, 5000);
    return tl;
  }

  /* ---- arriving from a page wipe ---- */
  if (html.classList.contains('wipe-in')) {
    if (gsap && !M.reduced) reveal();
    else html.classList.remove('wipe-in');
  }

  /* ---- leaving through a link ---- */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    var raw = a.getAttribute('href') || '';
    if (!raw || raw.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(raw)) return;
    var url;
    try { url = new URL(a.href, window.location.href); } catch (err) { return; }
    if (url.origin !== window.location.origin) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    if (M.reduced || !gsap) return;                         // plain navigation, no wipe
    e.preventDefault();
    try { window.sessionStorage.setItem('nova-wipe', '1'); } catch (err) {}
    var go = function () { window.location.assign(url.href); };
    gsap.fromTo(panel, { yPercent: 100, autoAlpha: 1 }, { yPercent: 0, duration: 0.45, ease: M.EASE.wipe, onComplete: go });
    window.setTimeout(go, 900);                              // never strand the visitor on a stalled tween
  });

  /* ---- back/forward cache: the page comes back exactly as it was left, panel included ---- */
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    html.classList.remove('wipe-in', 'intro', 'm-fade');
    if (gsap) gsap.killTweensOf(panel);
    hidePanel();
  });

  /* ---- journey stages inside the app ---- */
  var GROUP = { start: 'gate', consent: 'consent', intake: 'call', extracting: 'build', review: 'build',
    generating: 'build', blueprint: 'build', booking: 'booking', done: 'done' };
  var last = document.body.dataset.stage || null;
  new MutationObserver(function () {
    var now = document.body.dataset.stage || null;
    if (!now || now === last) return;
    var prev = last;
    last = now;
    if (!prev || !gsap) return;
    if (M.reduced) { M.fadeIn(document.getElementById('app')); return; }
    if (GROUP[prev] === GROUP[now]) {
      // Same phase: the content cross-fades; the header, rail and controls stay still.
      M.fadeIn(document.querySelectorAll('#main-content > :not(.steps):not(.steps-bar)'), { duration: 0.2 });
      return;
    }
    reveal();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-stage'] });
})();
