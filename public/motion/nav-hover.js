/* Nav menu hover: the main nav labels letter-roll on hover and on :focus-visible. Pure CSS
 * (styles.css, "Nav hover"); this file only splits the labels into the two-copy structure:
 *   .nr-c  a 1.25em-tall, overflow-hidden box per character, --i = its index
 *   .nr-a / .nr-b  the two copies, which both move translateY(-100%) on hover.
 * Only the main nav: the top bar's "Start over", the footer links, and on the Terms page the
 * "Back to Nova" button and the contents links. Never journey content or anything live.
 * Text nodes are split; icons and other elements inside a label are left as they are.
 * Off for touch and reduced motion (no split at all, so the label is plain text).
 */
(function () {
  'use strict';
  var M = window.NovaMotion;
  if (!M || M.reduced || !M.finePointer) return;
  var NAV = '.topbar-right .btn, .footer a, .legal-top .btn, .legal-toc a';

  function splitLabel(host) {
    if (host.__nr) return;
    host.__nr = true;
    var i = 0;
    Array.prototype.slice.call(host.childNodes).forEach(function (n) {
      if (n.nodeType !== 3 || !n.textContent.trim()) return;
      var text = n.textContent;
      var frag = document.createDocumentFragment();
      var sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = text.trim();
      frag.appendChild(sr);
      var vis = document.createElement('span');
      vis.className = 'nr';
      vis.setAttribute('aria-hidden', 'true');
      text.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { vis.appendChild(document.createTextNode(' ')); return; }
        var w = document.createElement('span');
        w.className = 'nr-w';
        Array.from(part).forEach(function (ch) {
          var box = document.createElement('span');
          box.className = 'nr-c';
          box.style.setProperty('--i', i++);
          var a = document.createElement('span'); a.className = 'nr-a'; a.textContent = ch;
          var b = document.createElement('span'); b.className = 'nr-b'; b.textContent = ch;
          box.appendChild(a); box.appendChild(b); w.appendChild(box);
        });
        vis.appendChild(w);
      });
      frag.appendChild(vis);
      n.parentNode.replaceChild(frag, n);
    });
    host.classList.add('nr-host');
  }
  function scan() { Array.prototype.forEach.call(document.querySelectorAll(NAV), splitLabel); }
  scan();
  // app.js re-renders the top bar and footer with innerHTML: split the new labels as they arrive.
  var app = document.getElementById('app');
  if (app) new MutationObserver(scan).observe(app, { childList: true });
})();
