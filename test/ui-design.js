/* Design-system checks for the responsive UI (run: node test/ui-design.js).
 *
 * The layout cannot be rendered headlessly here, so this checks the three things a redesign
 * silently breaks and that the browser would not report:
 *   1. the stylesheet still parses, and every class public/app.js renders has a rule,
 *   2. every text/background pair in the design tokens clears WCAG AA,
 *   3. the interactive controls keep a 44px touch target on phones.
 *
 * The DOM itself (all screens, both microphone states) is covered by test/ui-smoke.js.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const dom = new JSDOM('<!doctype html><html><head><style>' + css + '</style></head><body></body></html>');
const sheet = dom.window.document.styleSheets[0];

/* ------------------------------------------------------------------ */
section('stylesheet parses and covers the app');

let ruleCount = 0;
const selectors = [];
const media = new Set();
(function walk(list) {
  for (const r of list) {
    ruleCount++;
    if (r.media && r.media.mediaText) media.add(r.media.mediaText.trim());
    if (r.cssRules) walk(r.cssRules);
    if (r.selectorText) selectors.push(r.selectorText);
  }
})(sheet.cssRules);

ok(ruleCount > 300, 'the stylesheet parsed into ' + ruleCount + ' rules (a parse error would collapse it)');
ok([...media].some(m => /\(min-width/.test(m)), 'the layout is mobile-first (min-width breakpoints: ' + [...media].filter(m => /min-width/.test(m)).length + ')');
ok([...media].some(m => /prefers-reduced-motion/.test(m)), 'reduced-motion is honoured');
ok([...media].some(m => /forced-colors/.test(m)), 'forced-colours (high contrast) mode is handled');

// Every class the app renders must have at least one rule, or the redesign dropped a style.
const used = new Set();
const classRe = /class=(?:\\?"|\\?')([^"'\\]+)/g;
let m;
while ((m = classRe.exec(appJs))) {
  m[1].split(/\s+/).forEach(c => { if (c && !/[+'"']/.test(c)) used.add(c); });
}
// Classes JS adds at runtime rather than writing into the markup.
['active', 'done', 'filled', 'null', 'pending', 'speaking', 'listening', 'thinking', 'error', 'complete',
 'ready', 'live', 'sel', 'show', 'err', 'side-open', 'is-null', 'review-full', 'won', 'lost'].forEach(c => used.add(c));
const selectorBlob = selectors.join(' ');
const missing = [...used].filter(c => !new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![\\w-])').test(selectorBlob));
ok(missing.length === 0, 'all ' + used.size + ' classes rendered by app.js have a rule' + (missing.length ? ': missing ' + missing.join(', ') : ''));

// And no rule may put white text on the brand fill: white on #F57C1F is 2.7:1.
const whiteOnBrand = [];
(function walk2(list) {
  for (const r of list) {
    if (r.cssRules) walk2(r.cssRules);
    if (!r.style) continue;
    const bg = (r.style.background || '') + (r.style.backgroundColor || '');
    if (/var\(--brand\)/.test(bg) && /(#fff\b|#ffffff|white)/i.test(r.style.color || '')) whiteOnBrand.push(r.selectorText);
  }
})(sheet.cssRules);
ok(whiteOnBrand.length === 0, 'no white text sits on the brand fill (white on #F57C1F is 2.7:1)' + (whiteOnBrand.length ? ': ' + whiteOnBrand.join(', ') : ''));

/* ------------------------------------------------------------------ */
section('design tokens clear WCAG AA');

const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('\n}', css.indexOf(':root')));
const tokens = {};
for (const t of rootBlock.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) tokens[t[1]] = t[2];
const hex2rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = h => { const [r, g, b] = hex2rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const PAIRS = [
  ['body text on a card', '--ink', '--card', 4.5],
  ['body text on the page', '--ink', '--bg', 4.5],
  ['muted text on a card', '--muted', '--card', 4.5],
  ['muted text on the page', '--muted', '--bg', 4.5],
  ['helper text on a card', '--faint', '--card', 4.5],
  ['helper text on the page', '--faint', '--bg', 4.5],
  ['primary button label', '#FFFFFF', '--navy', 4.5],
  ['primary button hover stop', '#FFFFFF', '--navy-700', 4.5],
  ['toast and user bubble label', '#FFFFFF', '--navy-900', 4.5],
  ['brand text on a card', '--brand-ink', '--card', 4.5],
  ['brand text on brand-soft', '--brand-ink', '--brand-soft', 4.5],
  ['success text', '--green', '--green-soft', 4.5],
  ['warning text', '--amber', '--amber-soft', 4.5],
  ['error text', '--red', '--red-soft', 4.5],
  ['AI bubble and your-answer line', '--navy', '--steel-soft', 4.5],
  ['links on a card', '--navy-600', '--card', 4.5],
  ['knowledge-base chips', '--navy', '--steel-soft', 4.5],
  ['info note text', '--info', '--info-soft', 4.5],
  ['entry-gate lede on navy', '#CBDCE9', '--navy', 4.5],
  ['entry-gate mini-step text', '#B9CEDF', '--navy-900', 4.5],
  ['entry-gate accent headline', '#FFC08A', '--navy', 3],
  ['numerals on the brand fill', '--navy-900', '--brand', 3],
  ['logo navy stroke on its plate', '--navy', '#FFFFFF', 3],
  ['logo steel stroke on its plate', '--steel', '#FFFFFF', 3],
  ['the logo plate on the navy hero', '#FFFFFF', '--navy', 3]
];
for (const [label, fg, bg, min] of PAIRS) {
  const f = tokens[fg] || fg, b = tokens[bg] || bg;
  if (!f || !b) { ok(false, label + ': token missing (' + fg + '/' + bg + ')'); continue; }
  const r = ratio(f, b);
  ok(r >= min, label.padEnd(30) + r.toFixed(2) + ':1 (need ' + min + ':1)');
}

/* ------------------------------------------------------------------ */
section('the brand mark is never bare on a dark surface');

/* logoMark() draws navy #0F2F52 and steel #3E6C8E strokes. Against the entry-gate hero (a navy
   gradient) those measure 1.00:1 and 2.42:1, so an un-plated mark vanishes. Every call must either
   pass a mono colour - the call orb, which is its own background - or go through logoTile(). */
const bareMarks = (appJs.match(/logoMark\([^)]*\)/g) || [])
  .filter(c => !/'#[0-9A-Fa-f]{6}'/.test(c))   // a mono call paints itself for its own background
  .filter(c => !/mono/.test(c));               // ...and skip the function definition itself
ok(bareMarks.length === 1 && /logoMark\(h\)/.test(bareMarks[0]),
  'the only bare logoMark() call is the one inside logoTile() (' + bareMarks.length + ' found)');
const platedMarks = (appJs.match(/logoTile\(\d+\)/g) || []).length;
ok(platedMarks >= 3, 'the header, the entry-gate hero and the done card all render the mark on a plate (' + platedMarks + ' plates)');
ok(/\.logo-plate\s*{[^}]*background:\s*#FFFFFF/i.test(css), '.logo-plate has a light background of its own');
ok(/\.gate-brand \.logo-plate/.test(css), 'the plate gets extra separation on the dark hero');
ok(fs.existsSync(path.join(__dirname, '..', 'public', 'logo-on-dark.svg')), 'public/logo-on-dark.svg ships for dark decks and slides');

/* ------------------------------------------------------------------ */
section('touch targets on phones');

const px = v => {
  const s = String(v || '').trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return /rem$/.test(s) ? n * 16 : /px$/.test(s) ? n : null;
};
// Resolve a selector's declared box height, walking the cascade in source order.
function heightOf(selectorText) {
  let best = null;
  (function walk3(list) {
    for (const r of list) {
      if (r.cssRules) { walk3(r.cssRules); continue; }
      if (!r.selectorText || !r.style) continue;
      if (!r.selectorText.split(',').some(s => s.trim() === selectorText)) continue;
      const h = px(r.style.minHeight) || px(r.style.height);
      if (h) best = h;
    }
  })(sheet.cssRules);
  return best;
}
const tapValue = parseFloat((css.match(/--tap:\s*([\d.]+)px/) || [])[1]);
ok(tapValue >= 44, 'the --tap token is a 44px minimum touch target (' + tapValue + 'px)');
for (const sel of ['.btn', '.icon-btn', '.day', '.slot', '.tbl .del']) {
  const h = heightOf(sel);
  ok(h === null || h >= 40, sel + ' keeps a finger-sized target (' + (h == null ? 'min-height: var(--tap)' : h + 'px') + ')');
}
ok(/min-height:\s*var\(--tap\)/.test(css), 'buttons and inputs declare min-height: var(--tap)');
ok(/env\(safe-area-inset-bottom/.test(css), 'the layout respects the iOS home-indicator inset');
ok(/@media \(max-width: 899px\)[\s\S]{0,400}call-controls[\s\S]{0,200}sticky/.test(css),
  'the call controls stay pinned above the keyboard on phones');

console.log('\n' + (failures === 0 ? 'UI DESIGN CHECKS PASSED' : failures + ' UI DESIGN FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
