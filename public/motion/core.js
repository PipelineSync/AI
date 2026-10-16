/* Motion core - shared by every motion module (public/motion/*.js). Needs GSAP 3
 * (public/vendor/gsap.min.js); without it every helper falls back to "show it now".
 *
 * Rules every module follows:
 *  - only transform and opacity are animated (clip-path is allowed for full-screen wipes);
 *  - an element's CSS transition is switched off while GSAP animates it (class m-busy);
 *  - faded-out elements use autoAlpha, so they stop receiving clicks;
 *  - reduced motion: no letter splitting, no wipes, only 0.3s fades, nothing left hidden.
 */
window.NovaMotion = (function () {
  'use strict';
  var gsap = window.gsap || null;
  var mq = function (q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } };
  var reduced = mq('(prefers-reduced-motion: reduce)');
  var finePointer = mq('(hover: hover) and (pointer: fine)');

  // Easing tokens: roll for letter rolls and entrances, reveal for content, wipe for page panels.
  var EASE = { roll: 'expo.out', reveal: 'power3.out', wipe: 'power4.inOut' };
  if (gsap) gsap.defaults({ ease: EASE.reveal, overwrite: 'auto' });

  /* Switch CSS transitions off while GSAP drives an element, and back on afterwards. */
  function busy(targets) {
    var els = toArray(targets);
    els.forEach(function (el) { el.classList.add('m-busy'); });
    return function () { els.forEach(function (el) { el.classList.remove('m-busy'); }); };
  }
  function toArray(t) {
    if (!t) return [];
    if (typeof t === 'string') return Array.prototype.slice.call(document.querySelectorAll(t));
    if (t.length != null && !t.nodeType) return Array.prototype.slice.call(t).filter(Boolean);
    return [t];
  }
  /* gsap.fromTo with the m-busy guard. Returns the tween, or null when there is nothing to do. */
  function tween(targets, from, to) {
    var els = toArray(targets);
    if (!els.length) return null;
    if (!gsap) return null;
    var done = busy(els);
    var onComplete = to.onComplete;
    to.onComplete = function () { done(); if (onComplete) onComplete.apply(this, arguments); };
    return gsap.fromTo(els, from, to);
  }
  /* A plain 0.3s fade, the only motion reduced-motion users get. Never leaves anything hidden. */
  function fadeIn(targets, opts) {
    var els = toArray(targets);
    if (!els.length) return null;
    if (!gsap) { els.forEach(function (el) { el.style.opacity = ''; el.style.visibility = ''; }); return null; }
    return tween(els, { autoAlpha: 0 }, Object.assign({ autoAlpha: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity,visibility' }, opts || {}));
  }

  /* ---------------- Letter-roll splitter ----------------
     Each character sits in a one-line, overflow-hidden box holding two copies; words stay
     together (nowrap). The split copy is aria-hidden and an sr-only copy carries the text.
     A gradient phrase (.accent) rolls word by word so each word keeps its gradient fill. */
  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function split(el) {
    if (!el) return null;
    if (el.__lr) return el.__lr;
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var lh = parseFloat(window.getComputedStyle(el).lineHeight);
    if (!(lh > 0)) lh = parseFloat(window.getComputedStyle(el).fontSize) * 1.2;
    var vis = make('span', 'lr');
    vis.setAttribute('aria-hidden', 'true');
    var stacks = [], firsts = [];
    function addWords(str, container, accent) {
      str.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { container.appendChild(document.createTextNode(' ')); return; }
        var word = make('span', 'lr-w');
        (accent ? [part] : Array.from(part)).forEach(function (unit) {
          var box = make('span', 'lr-c');
          var stack = make('span', 'lr-s');
          var a = make('span', 'lr-a' + (accent ? ' accent' : ''), unit);
          var b = make('span', 'lr-b' + (accent ? ' accent' : ''), unit);
          stack.appendChild(a); stack.appendChild(b); box.appendChild(stack); word.appendChild(box);
          stacks.push(stack); firsts.push(a);
        });
        container.appendChild(word);
      });
    }
    Array.prototype.slice.call(el.childNodes).forEach(function (n) {
      if (n.nodeType === 3) addWords(n.textContent, vis, false);
      else if (n.nodeType === 1) {
        var accent = n.classList.contains('accent');
        var wrap = n.cloneNode(false);
        wrap.removeAttribute('id');
        if (accent) wrap.classList.remove('accent');
        addWords(n.textContent, wrap, accent);
        vis.appendChild(wrap);
      }
    });
    el.style.setProperty('--lr-lh', lh + 'px');
    el.textContent = '';
    el.appendChild(make('span', 'sr-only', text));
    el.appendChild(vis);
    el.__lr = { stacks: stacks, firsts: firsts };
    return el.__lr;
  }
  /* Hide a title's first copies now, so a roll that starts later never flashes the text. */
  function prepRoll(el) {
    if (reduced || !gsap) return null;
    var lr = split(el);
    if (lr) gsap.set(lr.firsts, { opacity: 0 });
    return lr;
  }
  /* Letter-roll entrance: the stack moves yPercent 0 -> -50 (the hidden first copy leaves, the
     second rolls up into view), 0.02s per character, 0.8s, expo.out; then both reset to the
     identical resting state. Reduced motion or no GSAP: a 0.3s fade instead. */
  function rollIn(el, opts) {
    opts = opts || {};
    if (!el) return null;
    if (reduced || !gsap) return fadeIn(el, { delay: opts.delay || 0 });
    var lr = prepRoll(el);
    if (!lr) return null;
    var tl = gsap.timeline({ delay: opts.delay || 0 });
    tl.fromTo(lr.stacks, { yPercent: 0 }, { yPercent: -50, duration: 0.8, ease: EASE.roll, stagger: 0.02 })
      .set(lr.stacks, { yPercent: 0 })
      .set(lr.firsts, { opacity: 1 }, '<');   // tweens, not a callback: a seek past the end still lands here
    return tl;
  }

  /* Page titles that letter-roll: the entry greeting, each stage's heading, the Terms title.
     Never chat text, live subtitles, inputs or anything that updates while on screen. */
  var TITLE_SEL = [
    '.gate-brand h1',
    '#main-content .consent-card > h2', '#main-content .loader h2', '#main-content .review-header h2',
    '#main-content .doc-head h2', '#main-content .booking .card > h2', '#main-content .done-card > h2',
    '#main-content .nova-empty h2', '.legal-head h1'
  ].join(', ');
  function pageTitle() { return document.querySelector(TITLE_SEL); }

  return {
    gsap: gsap, reduced: reduced, finePointer: finePointer, EASE: EASE,
    busy: busy, tween: tween, fadeIn: fadeIn, toArray: toArray,
    split: split, prepRoll: prepRoll, rollIn: rollIn, pageTitle: pageTitle
  };
})();
