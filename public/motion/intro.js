/* First-load intro (once per session) and the 0.3s fade for every later load.
 *
 * boot.js put class "intro" on <html> before the body painted, so styles.css keeps the shell
 * hidden. This file sets each timeline's start states, then removes the class, then plays.
 * The form or call controls are only faded with opacity (never visibility), so they stay
 * focusable: typing works from the first frame, and focus lands on them as they arrive.
 *
 * On the sign-in screen the intro opens with a text splash: "Nova AI" letter-rolls in, "Your AI
 * towards your goal." rises under it, it holds, then the splash wipes up and the sign-in screen
 * enters underneath. Clicking or pressing any key skips the splash. Reduced motion gets the same
 * splash with 0.3s fades only.
 */
(function () {
  'use strict';
  var M = window.NovaMotion;
  var html = document.documentElement;
  var gsap = M && M.gsap;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var show = function () { html.classList.remove('intro', 'm-fade'); };
  var firstVisit = true;
  try { firstVisit = window.sessionStorage.getItem('nova-intro') !== '1'; } catch (e) {}
  var onSignIn = document.body.dataset.stage === 'start';

  /* The text splash. Decorative (the sign-in screen carries the same name), so aria-hidden. */
  function makeSplash() {
    var sp = document.createElement('div');
    sp.className = 'intro-splash';
    sp.setAttribute('aria-hidden', 'true');
    sp.innerHTML = '<div class="intro-splash-inner"><p class="intro-splash-title">Nova <span class="accent">AI</span></p>' +
      '<p class="intro-splash-tag">Your AI towards your goal.</p></div>';
    document.body.appendChild(sp);
    return sp;
  }
  /* Safety timers count from the first frame the browser actually draws. While the page is not
     on screen (a background tab, a frame still loading) animations are paused, and a plain
     timer would skip the intro before anyone saw it. */
  function afterFirstFrame(fn, ms) {
    var tick = function () { gsap.ticker.remove(tick); window.setTimeout(fn, ms); };
    gsap.ticker.add(tick);
  }
  /* Click or any key jumps the splash to its end; it is never in the way for long. */
  function skippable(sp, tl) {
    var skip = function () { if (tl.progress() < 1) tl.progress(1); };
    sp.addEventListener('pointerdown', skip);
    document.addEventListener('keydown', skip, { once: true, capture: true });
    tl.eventCallback('onComplete', function () { document.removeEventListener('keydown', skip, true); });
    afterFirstFrame(skip, 4000);                            // the sign-in screen is always up by 5s
  }

  if (html.classList.contains('m-fade')) {
    if (gsap && M.reduced && firstVisit && onSignIn) {
      // Reduced motion, first visit: the splash with fades only, then the page is simply there.
      try { window.sessionStorage.setItem('nova-intro', '1'); } catch (e) {}
      var rsp = makeSplash();
      var inner = rsp.firstChild;
      show();
      var rtl = gsap.timeline()
        .fromTo(inner, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: 'power1.out' })
        .to(rsp, { autoAlpha: 0, duration: 0.3, ease: 'power1.out' }, '+=1.2')
        .call(function () { rsp.remove(); });
      skippable(rsp, rtl);
      return;
    }
    // Later loads and reduced motion: one 0.3s fade of the page, nothing else.
    if (gsap) gsap.fromTo([$('#app') || $('.legal-wrap')].filter(Boolean), { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity', onStart: show });
    else show();
    return;
  }
  if (!html.classList.contains('intro')) return;            // wipe-in: transitions.js takes over
  if (!gsap || !M) { show(); return; }
  try { window.sessionStorage.setItem('nova-intro', '1'); } catch (e) {}

  var stage = document.body.dataset.stage || (document.body.classList.contains('legal-page') ? 'terms' : 'start');
  var tl = null, done = null;
  var focusOnLand = null;
  // With the splash, the sign-in timeline is built (start states set) but waits for it.
  var splash = stage === 'start' ? makeSplash() : null;
  var started = !splash;

  /* Shared pieces: header slides down, step rail ("sidebar") slides in, its items follow. */
  function header(el) {
    if (!el) return;
    gsap.set(el, { yPercent: -100, autoAlpha: 0 });
    tl.to(el, { yPercent: 0, autoAlpha: 1, duration: 0.8, clearProps: 'transform,opacity,visibility' }, 0);
  }
  function rail(el, items) {
    if (!el) return;
    gsap.set(el, { x: -24, autoAlpha: 0 });
    tl.to(el, { x: 0, autoAlpha: 1, duration: 0.6, clearProps: 'transform,opacity,visibility' }, 0);
    items = items.slice(0, 12);
    if (items.length) {
      gsap.set(items, { autoAlpha: 0 });
      tl.to(items, { autoAlpha: 1, duration: 0.35, stagger: 0.04, clearProps: 'opacity,visibility' }, 0.2);
    }
  }
  /* The "composer": rises from below and gets focus the moment it lands. Opacity only. */
  function composer(el, at) {
    if (!el) return;
    gsap.set(el, { y: 40, opacity: 0 });
    tl.to(el, { y: 0, opacity: 1, duration: 0.6, clearProps: 'transform,opacity', onComplete: landFocus }, at);
  }
  function landFocus() {
    var t = focusOnLand && focusOnLand();
    if (t && document.activeElement !== t && (!document.activeElement || document.activeElement === document.body)) {
      try { t.focus({ preventScroll: true }); } catch (e) {}
    }
  }
  function fadeUp(els, at, stagger) {
    els = els.filter(Boolean);
    if (!els.length) return;
    gsap.set(els, { y: 16, autoAlpha: 0 });
    tl.to(els, { y: 0, autoAlpha: 1, duration: 0.5, stagger: stagger || 0, clearProps: 'transform,opacity,visibility' }, at);
  }

  /* Builds the whole timeline on the elements on screen now. app.js can re-render the screen
     while the intro plays (the sign-in screen re-renders once its config arrives); the
     timeline is then rebuilt on the new elements and picks up at the same moment. */
  function build() {
    tl = gsap.timeline({ defaults: { ease: M.EASE.reveal }, paused: !started });
    if (stage === 'start') {
      // Sign-in: logo down, greeting rolls at 0.25s, chips rise at 0.6s, the form rises at 0.5s.
      header($('.gate-logo'));
      fadeUp([$('.gate-name')], 0.1);
      var h1 = $('.gate-brand h1');
      if (h1) { M.prepRoll(h1); tl.add(M.rollIn(h1), 0.25); }
      fadeUp([$('.gate-brand .lede')], 0.45);
      fadeUp($$('.gate-trust .trust-item'), 0.6, 0.06);
      composer($('.gate-side'), 0.5);
      focusOnLand = function () {
        var n = $('#st-name'), e = $('#st-email');
        return n && !n.value ? n : (e && !e.value ? e : n);
      };
    } else if (stage === 'terms') {
      header($('.legal-top'));
      rail($('.legal-toc'), $$('.legal-toc li'));
      var t1 = $('.legal-head h1');
      if (t1) { M.prepRoll(t1); tl.add(M.rollIn(t1), 0.25); }
      fadeUp([$('.legal-head .telem'), $('.legal-head .lede'), $('.legal-head .meta')], 0.35, 0.06);
      fadeUp([$('.legal-body')], 0.5);
    } else {
      // A signed-in screen on first load (consent, or a journey restored after a reload).
      header($('.topbar'));
      rail($('.steps'), $$('.steps .step'));
      fadeUp([$('.steps-bar')], 0.3);
      if (stage === 'consent') {
        // Consent reads like the greeting: its title rolls, the card rises like the composer.
        var ct = $('.consent-card > h2');
        if (ct) { M.prepRoll(ct); tl.add(M.rollIn(ct), 0.25); }
        composer($('.consent-card'), 0.15);
        focusOnLand = function () { return $('#consent-cb'); };
      } else {
        // An existing journey: no greeting. Its content fades in together, already in place.
        var content = $$('#main-content > :not(.steps):not(.steps-bar)');
        var controls = $('.call-controls');   // the call card fades in; its controls rise inside it
        gsap.set(content, { autoAlpha: 0 });
        tl.to(content, { autoAlpha: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity,visibility' }, 0.2);
        if (controls) composer(controls, 0.5);
      }
      fadeUp([$('.footer')], 0.5);
    }
    if (done) done();
    done = M.busy($$('.btn, .step, .trust-item, .gate-card'));
    tl.eventCallback('onComplete', function () { done(); watch.disconnect(); });
  }

  var app = document.getElementById('app');
  var watch = new MutationObserver(function () {
    if (!tl || tl.progress() >= 1) return;
    var t = tl.time();
    tl.kill();
    build();
    tl.time(t, true);
  });
  build();
  if (splash) {
    // "Nova AI" rolls, the line rises, both lift away, the panel wipes up, the sign-in enters.
    var title = splash.querySelector('.intro-splash-title');
    var tag = splash.querySelector('.intro-splash-tag');
    M.prepRoll(title);
    gsap.set(tag, { y: 16, autoAlpha: 0 });
    var pre = gsap.timeline();
    pre.add(M.rollIn(title), 0.1)
      .to(tag, { y: 0, autoAlpha: 1, duration: 0.6, ease: M.EASE.reveal }, 0.5)
      .to(splash.firstChild, { y: -24, autoAlpha: 0, duration: 0.4, ease: 'power3.in' }, 1.7)
      .to(splash, { yPercent: -100, duration: 0.6, ease: M.EASE.wipe }, 1.95)
      .call(function () { started = true; tl.play(); }, null, 2.15)
      .call(function () { splash.remove(); });
    skippable(splash, pre);
  }
  // Runs after a re-render and before the browser paints it, so the new screen never flashes.
  if (app) watch.observe(app, { childList: true });
  // Start states are set: let the shell paint, then play (about 1.8s end to end).
  html.classList.remove('intro');
  // If anything stalls, jump to the end within 5s so nothing is left hidden.
  afterFirstFrame(function () { watch.disconnect(); if (tl.progress() < 1) tl.progress(1); }, 5000);
})();
