/* Motion boot - loaded in <head>, before the body paints.
 *
 * Decides how this page load enters, by a class on <html> that styles.css reads:
 *   intro    first load of the session: the shell is hidden until intro.js has set the start
 *            states of its timeline (public/motion/intro.js)
 *   wipe-in  arriving from a page wipe (transitions.js): a full-screen panel covers the page
 *            until it slides away
 *   m-fade   every other load, and reduced motion: a 0.3s fade of the app
 * Nothing may stay hidden if a later script fails: every class is removed after 5s regardless.
 * The script is external (not inline) because the CSP allows scripts from 'self' only.
 */
(function () {
  var d = document.documentElement;
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var played = false, wipe = false;
  try { played = window.sessionStorage.getItem('nova-intro') === '1'; } catch (e) {}
  try { wipe = window.sessionStorage.getItem('nova-wipe') === '1'; window.sessionStorage.removeItem('nova-wipe'); } catch (e) {}
  if (reduced) d.classList.add('m-fade');
  else if (wipe) d.classList.add('wipe-in');
  else if (!played) d.classList.add('intro');
  else d.classList.add('m-fade');
  // Safety net: whatever happens to the scripts below, the page shows within 5s.
  window.setTimeout(function () { d.classList.remove('intro', 'wipe-in', 'm-fade'); }, 5000);
})();
