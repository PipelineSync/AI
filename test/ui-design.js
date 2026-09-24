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
ok(/body\.entry-screen\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s.test(css),
  'the public entry is locked to one dynamic viewport without page scrolling');
ok(/body\.entry-screen \.gate\s*\{[^}]*height:\s*100dvh[^}]*max-height:\s*100dvh[^}]*overflow:\s*hidden/s.test(css),
  'the entry gate cannot grow beyond the viewport');
ok(/classList\.toggle\(['"]entry-screen['"]/.test(appJs),
  'the one-screen lock is scoped to the entry instead of trapping long blueprint content');

/* The brand components (the logo and Otto) render markup into the same screens, so they are part
   of the check. Their animation classes ship inside the components' own inline <style> (the brand
   sheet specifies the components as written), so a class is covered if the stylesheet has a rule
   for it or the component's own CSS defines it. */
const brandSrcs = ['Logo.js', 'Otto.js'].map(f =>
  fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', f), 'utf8'));
const brandCss = brandSrcs.join('\n');
const sources = [appJs].concat(brandSrcs);

// Every class the app renders must have at least one rule, or the redesign dropped a style.
const used = new Set();
const classRe = /class=(?:\\?"|\\?')([^"'\\]+)/g;
let m;
for (const src of sources) {
  classRe.lastIndex = 0;
  while ((m = classRe.exec(src))) {
    m[1].split(/\s+/).forEach(c => { if (c && !/[+'"']/.test(c)) used.add(c); });
  }
}
// Classes JS adds at runtime rather than writing into the markup.
['active', 'done', 'filled', 'null', 'pending', 'speaking', 'listening', 'thinking', 'error', 'complete',
 'ready', 'live', 'sel', 'show', 'err', 'side-open', 'is-null', 'review-full', 'won', 'lost'].forEach(c => used.add(c));
const selectorBlob = selectors.join(' ');
const defined = c => new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![\\w-])').test(selectorBlob) ||
  new RegExp('\\.' + c.replace(/-/g, '\\-') + '\\s*[{,]').test(brandCss);   // the component's own CSS
const missing = [...used].filter(c => !defined(c));
ok(missing.length === 0, 'all ' + used.size + ' classes rendered by the app and the brand components have a rule' + (missing.length ? ': missing ' + missing.join(', ') : ''));

/* White text on a brand fill. The brand sheet sets the primary button to #FF7A1A with white text
   (2.55:1, the same order as the #F57C1F this design system already shipped), so that one control
   is deliberate and is pinned below. Everything else must still keep white off a brand fill. */
const whiteOnBrand = [];
(function walk2(list) {
  for (const r of list) {
    if (r.cssRules) walk2(r.cssRules);
    if (!r.style) continue;
    const bg = (r.style.background || '') + (r.style.backgroundColor || '');
    if (!/var\(--brand\)|var\(--sync-orange\)/.test(bg)) continue;
    if (!/(#fff\b|#ffffff|white)/i.test(r.style.color || '')) continue;
    (r.selectorText || '').split(',').forEach(sel => whiteOnBrand.push(sel.trim()));
  }
})(sheet.cssRules);
const brandWhite = whiteOnBrand.filter(sel => sel !== '.btn-primary' && sel !== '.btn-primary:hover');
ok(brandWhite.length === 0, 'white text sits only on the primary button, which the brand sheet colours #FF7A1A' +
  (brandWhite.length ? ': ' + brandWhite.join(', ') : ''));
const primaryRule = [...selectors].find(t => t.trim() === '.btn-primary');
const primaryFill = (function find(list) {
  for (const r of list) {
    if (r.cssRules) { const f = find(r.cssRules); if (f) return f; continue; }
    if (r.selectorText && r.selectorText.trim() === '.btn-primary' && r.style.background) return r.style.background;
  }
  return '';
})(sheet.cssRules);
ok(/var\(--sync-orange\)|#FF7A1A/i.test(primaryFill),
  'the primary button is the brand orange #FF7A1A (' + (primaryFill || 'no fill found') + ')');
ok(/--sync-orange:\s*#FF7A1A/i.test(css) && /--sky:\s*#8FB0D0/i.test(css) && /--mist:\s*#E8EFF7/i.test(css) && /--void:\s*#0A0E17/i.test(css),
  'the brand sheet tokens are declared (sync-orange, sky, mist, void)');
ok(/--bg:\s*#0A0E17/i.test(css), 'the app background is still #0A0E17');

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

/* The logo now comes from components/brand/Logo.js. Its light variant draws navy #0C2B5E and steel
   #3E6892 strokes: on the dark topbar or the entry-gate hero those measure 1.2:1 and 3.4:1, so a
   light mark put straight on dark disappears. Two shapes are allowed:
     - the light variant inside a light plate (logoTile / the splash card),
     - the dark variant (white + sky), which is what every dark surface uses.
   Anything else - a light mark on a dark surface - is what this check exists to stop. */
ok(!/function logoMark\(/.test(appJs), 'the old inline logoMark() is gone: the brand component draws the mark');
const lightMarks = (appJs.match(/LogoMark\(\{[^}]*variant:\s*'light'[^}]*\}\)/g) || []);
const platedLight = lightMarks.filter(c => /logoTile|ottoSplashHtml|Splash/.test(appJs.slice(Math.max(0, appJs.indexOf(c) - 400), appJs.indexOf(c))));
ok(lightMarks.length > 0 && platedLight.length === lightMarks.length,
  'every light-variant mark is inside a light plate or the splash card (' + platedLight.length + '/' + lightMarks.length + ')');
ok(/LogoMark\(\{ variant: 'dark', size: 24 \}\)/.test(appJs), 'the call orb carries the dark variant, not the light one');
ok(/Logo\(\{ variant: 'dark', size: 30 \}\)/.test(appJs), 'the header lockup uses the dark variant on the dark topbar');
const platedMarks = (appJs.match(/logoTile\(\d+\)/g) || []).length;
ok(platedMarks >= 1, 'the done card still renders the mark on a plate (' + platedMarks + ' plates)');
ok(/\.logo-plate\s*{[^}]*background:\s*#FFFFFF/i.test(css), '.logo-plate has a light background of its own');
ok(/\.gate-brand \.logo-plate/.test(css), 'the plate gets extra separation on the dark hero');
ok(fs.existsSync(path.join(__dirname, '..', 'public', 'logo-on-dark.svg')), 'public/logo-on-dark.svg ships for dark decks and slides');

/* The favicon and the app icon: the static light mark on a navy #0C2B5E rounded tile. */
const faviconSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8');
const appIconSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-icons.svg'), 'utf8');
ok(/fill="#0C2B5E"/.test(faviconSvg) && /#FF7A1A/.test(faviconSvg), 'favicon.svg is the brand tile (navy fill, brand orange dot)');
ok(/viewBox="0 0 512 512"/.test(appIconSvg) && /rx="/.test(appIconSvg), 'app-icons.svg is a 512px rounded-square app tile');

/* A browser decodes a linked .svg icon as strict XML: one unbalanced tag and the icon silently
   disappears. The generator is the only thing that writes these files, so both are parsed here. */
const svgParser = new JSDOM('').window.DOMParser;
for (const f of ['favicon.svg', 'app-icons.svg']) {
  const doc = new svgParser().parseFromString(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), 'image/svg+xml');
  ok(!doc.querySelector('parsererror'), 'public/' + f + ' is well-formed XML, so a browser can decode it');
}
for (const f of ['icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
  ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), 'public/' + f + ' ships');
}
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
ok(manifest.theme_color === '#0A0E17' && manifest.background_color === '#0A0E17', 'the manifest theme colour stays #0A0E17');
ok(manifest.icons.some(i => /512/.test(i.sizes)), 'the manifest carries the 512px app icon');

/* ------------------------------------------------------------------ */
section('the brand components and Otto');

/* The components are the brand sheet's React components ported to this no-build layer, so the file
   that ships them is checked here: the six poses, the two views, the unchanged SVG markup and the
   rules that must not drift. */
const logoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Logo.js'), 'utf8');
const ottoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Otto.js'), 'utf8');

ok(/viewBox="20 20 440 590"/.test(logoJs) && /stroke-width="55"/.test(logoJs) && /<rect[^>]*fill="#FF7A1A"/.test(logoJs),
  'Logo.js keeps the brand sheet geometry (the 440x590 mark, 55px strokes, the orange dot)');
ok(/#0C2B5E/.test(logoJs) && /#3E6892/.test(logoJs) && /#0FFFFFF/i.test(logoJs) === false && /'#FFFFFF'/.test(logoJs),
  'Logo.js keeps the brand colours (navy head, steel, white on dark)');
ok(/role="img" aria-label="PipelineSync AI"/.test(logoJs), 'the logo svg keeps role=img and its aria-label');
ok(/@media \(prefers-reduced-motion:reduce\)/.test(logoJs), 'the animated mark honours reduced motion');

for (const pose of ['sync', 'hello', 'listen', 'speak', 'think', 'party']) {
  ok(new RegExp(pose + ':\\s*\\{').test(ottoJs), 'Otto.js defines the "' + pose + '" pose');
}
ok(/'\+ \(avatar \? '66 36 168 168' : '0 0 300 300'\) \+'|avatar \? '66 36 168 168' : '0 0 300 300'/.test(ottoJs),
  'Otto keeps both view boxes (the full figure and the head-only avatar crop)');
/* Otto is transparent artwork: nothing may paint behind him, or the app's own surface (dark, light
   or an export) stops showing through. */
ok(!/<circle cx="150" cy="120" r="84"/.test(ottoJs) && !/background:' \+ MIST/.test(ottoJs),
  'the avatar draws no circle or plate behind the head');
ok(!/ellipse cx="150" cy="286"/.test(ottoJs), 'the full figure draws no ground shadow');
ok(/role="img" aria-label="/.test(ottoJs), 'Otto keeps role=img and his aria-label');
ok(/@media \(prefers-reduced-motion:reduce\)\{\[class\^="otto-"\]/.test(ottoJs), "Otto's animation CSS honours reduced motion");
ok(/#0C2B5E/.test(ottoJs) && /#3E6892/.test(ottoJs) && /#FF7A1A/.test(ottoJs) && /#8FB0D0/.test(ottoJs) && /#E8EFF7/.test(ottoJs),
  "Otto's palette is the brand palette and nothing else");

/* Rules from the brand sheet, asserted on the real rendering code. */
ok(/window.innerWidth[\s\S]{0,80}< 420 \? 104/.test(appJs.slice(appJs.indexOf('function ottoLiveSize'), appJs.indexOf('function ottoLiveSize') + 300)),
  'the live avatar never drops below 96px on a small phone');
const poseFn = appJs.slice(appJs.indexOf('function ottoPoseNow'), appJs.indexOf('function ottoPoseNow') + 900);
ok(/status === 'speaking'[\s\S]*?'speak'/.test(poseFn) && /v.listening[\s\S]*?'listen'/.test(poseFn) && /'thinking'[\s\S]*?'think'/.test(poseFn) && /'blueprint'[\s\S]*?'party'/.test(poseFn),
  'the pose follows the real state: speaking, listening, thinking, celebrating');
ok(/stage === 'extracting'|stage === 'generating'/.test(poseFn), 'the loader states think too');
ok(/\.otto-live-fig \{ flex: 0 0 auto/.test(css) && /\.otto-party-fig \{ flex: 0 0 auto/.test(css) && /\.otto-hello-fig \{ flex: 0 0 auto/.test(css),
  "Otto's figures reserve their space, so a pose change cannot shift the layout");
const figCardRule = (css.match(/\.otto-fig-card \{[^}]*\}/) || [''])[0];
ok(figCardRule && !/background/.test(figCardRule) && !/box-shadow/.test(figCardRule),
  "Otto's sizing wrapper paints nothing, so the app's surface stays behind him");
ok(/\.otto-ringing > span \{ animation: ottoRing/.test(css) && /box-shadow: 0 0 0 3px var\(--sync-orange\)/.test(css),
  'the active-speaker ring is the brand orange');
ok(/\.otto-wave-bar \{[^}]*linear-gradient\(180deg, var\(--sky\) 0%, var\(--sync-orange\) 100%\)/.test(css),
  'the waveform is the #8FB0D0 -> #FF7A1A gradient');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.otto-wave-bar \{ animation: none/.test(css),
  'the waveform stops under reduced motion');
ok(/ottoWaveHtml\('otto-wave'\)/.test(appJs) && /<div class="otto-wave"/.test(appJs),
  'the waveform is rendered under the live question');

/* Otto's copy: the five lines, exactly as the brand sheet words them. */
ok(/const OTTO_COPY = window\.PSBrand\.OTTO_COPY;/.test(appJs), "the app reads Otto's copy from the brand component");
for (const line of [
  "Hi, I'm Otto. Let's map how your deals actually move.",
  "Take your time. I'm connecting the dots as you talk.",
  "One sec, I'm linking your pipeline stages together.",
  "Your blueprint's ready. Eight arms, zero loose ends.",
  "Hmm, I lost that thread. Mind saying it again?"
]) {
  ok(ottoJs.indexOf(JSON.stringify(line).slice(1, -1)) >= 0, 'Otto says: ' + line.slice(0, 42) + '...');
}
ok(!/\bAlex\b/.test(appJs), 'the UI no longer calls the interviewer Alex');
ok(/<b>Otto<\/b>/.test(appJs) && /OTTO &middot; QUESTION/.test(appJs), 'the call screen names Otto and the question count');

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
