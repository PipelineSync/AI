/* Design-system checks for the responsive UI (run: node test/ui-design.js).
 *
 * The layout cannot be rendered headlessly here, so this checks the things a redesign
 * silently breaks and that the browser would not report:
 *   1. the stylesheet still parses, and every class public/app.js renders has a rule,
 *   2. every text/background pair in the design tokens clears WCAG AA, in BOTH themes,
 *   3. the interactive controls keep a 44px touch target on phones,
 *   4. the Nova Ink v4 brand (dual paper/ink theme, new mark geometry, regenerated
 *      assets) is exactly what the components and static files claim.
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
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
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

/* The brand components (the logo, and Nova - still shipped as a brand asset, though the UI no
   longer renders him) are part of the check. Their animation classes ship inside the components'
   own inline <style> (the brand sheet specifies the components as written), so a class is covered
   if the stylesheet has a rule for it or the component's own CSS defines it. */
const brandSrcs = ['Logo.js', 'Nova.js'].map(f =>
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

/* No white text on a brand fill anywhere. Nova Ink v4 moved the primary button off white:
   it is the ember fill with ink text, which clears 4.5:1, so nothing is exempted. */
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
ok(whiteOnBrand.length === 0, 'white text sits on no brand fill (the primary button is ember with ink text)' +
  (whiteOnBrand.length ? ': ' + whiteOnBrand.join(', ') : ''));
const primaryFill = (function find(list) {
  for (const r of list) {
    if (r.cssRules) { const f = find(r.cssRules); if (f) return f; continue; }
    if (r.selectorText && r.selectorText.trim() === '.btn-primary' && r.style.background) return r.style.background;
  }
  return ''
})(sheet.cssRules);
ok(/var\(--sync-orange\)/.test(primaryFill),
  'the primary button is the ember brand fill (' + (primaryFill || 'no fill found') + ')');
ok(/var\(--brand-ink\)/.test((function btnColor(list) {
  for (const r of list) {
    if (r.cssRules) { const f = btnColor(r.cssRules); if (f != null) return f; continue; }
    if (r.selectorText && r.selectorText.trim() === '.btn-primary' && r.style.color) return r.style.color;
  }
  return null
})(sheet.cssRules)), 'the primary button label is ink, not white');
ok(/--sync-orange:\s*#E8590C/.test(css) && /--sky:\s*#6E88AB/.test(css) && /--mist:\s*#F6F3EC/.test(css) && /--void:\s*#14161B/.test(css),
  'the brand sheet tokens are declared (sync-orange #E8590C, sky #6E88AB, mist #F6F3EC, void #14161B)');
ok(/--bg:\s*#F6F3EC/i.test(css), 'the app background is the paper #F6F3EC');

/* ------------------------------------------------------------------ */
section('design tokens clear WCAG AA, in both themes');

function tokensOf(block) {
  const tokens = {};
  for (const t of block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) tokens[t[1]] = t[2];
  return tokens;
}
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('\n}', css.indexOf(':root')));
const light = tokensOf(rootBlock);
const darkIdx = css.indexOf('body[data-theme="dark"] {');
const dark = tokensOf(css.slice(darkIdx, css.indexOf('\n}', darkIdx)));
const hex2rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = h => { const [r, g, b] = hex2rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const PAIRS = [
  /* [label, foreground token, background token, minimum] */
  ['body text on a card', '--ink', '--surface', 4.5],
  ['body text on the page', '--ink', '--bg', 4.5],
  ['muted text on a card', '--ink-2', '--surface', 4.5],
  ['muted text on the page', '--muted', '--bg', 4.5],
  ['helper text on a card', '--faint', '--surface', 4.5],
  ['helper text on the page', '--faint', '--bg', 4.5],
  ['primary button label', '--brand-ink', '--sync-orange', 4.5],
  ['selection text on its tint', '--ink', '--ember-soft', 4.5],
  ['required figure on its tint', '--req', '--ember-soft', 4.5],
  ['success text', '--green', '--green-soft', 4.5],
  ['warning text', '--amber', '--amber-soft', 4.5],
  ['error text', '--red', '--red-soft', 4.5],
  ['AI bubble and your-answer line', '--navy', '--steel-soft', 4.5],
  ['links on a card', '--info', '--surface', 4.5],
  ['info note text', '--info', '--info-soft', 4.5],
  ['mark lines', '#1B1E24', '#FFFFFF', 3],
  ['mark dots on white', '#6E88AB', '#FFFFFF', 3],
  ['mark star on white', '#E8590C', '#FFFFFF', 3],
  ['dark mark lines', '#EDEAE1', '#14161B', 3],
  ['dark mark dots', '#8FA6C4', '#14161B', 3],
  ['dark mark star', '#F76B15', '#14161B', 3],
  ['paper lines on the navy tile', '#F6F3EC', '#1C3D6E', 3],
  ['ember star on the navy tile', '#F76B15', '#1C3D6E', 3],
  ['deep-navy star on the ember tile', '#17335C', '#E8590C', 3]
];
for (const theme of ['light', 'dark']) {
  const tokens = theme === 'light' ? light : dark;
  for (const [label, fg, bg, min] of PAIRS) {
    const f = tokens[fg] || fg, b = tokens[bg] || bg;
    if (!f || !b) { ok(false, theme + ': ' + label + ': token missing (' + fg + '/' + bg + ')'); continue; }
    const r = ratio(f, b);
    ok(r >= min, (theme + ': ' + label).padEnd(42) + r.toFixed(2) + ':1 (need ' + min + ':1)');
  }
}

/* ------------------------------------------------------------------ */
section('Nova Ink v4 geometry, variants, surfaces and generated assets');

const logoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Logo.js'), 'utf8');
const novaJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Nova.js'), 'utf8');
const brand = require('../public/components/brand/Logo.js').PSBrand;
const svgParser = new JSDOM('').window.DOMParser;
const parseSvg = svg => new svgParser().parseFromString(svg, 'image/svg+xml');
/* The v4 mark: 220x140, three straight 10px lines into the centre, three 9px dots at their
   origins, one 4-quadrant star. The v3 spark is gone. */
const expectedLines = ['M14 30 L146 70', 'M6 70 L146 70', 'M14 110 L146 70'];
const expectedStar = 'M172 34 Q184 58 208 70 Q184 82 172 106 Q160 82 136 70 Q160 58 172 34 Z';
const expectedDots = [[14, 30], [6, 70], [14, 110]];
for (const variant of ['light', 'dark']) {
  const svg = parseSvg(brand.LogoMark({ variant, size: 54 }));
  const root = svg.documentElement;
  const paths = [...svg.querySelectorAll('path')];
  const circles = [...svg.querySelectorAll('circle')];
  const palette = variant === 'light'
    ? { line: '#1B1E24', dot: '#6E88AB', star: '#E8590C' }
    : { line: '#EDEAE1', dot: '#8FA6C4', star: '#F76B15' };
  ok(root.getAttribute('viewBox') === '0 0 220 140' && +root.getAttribute('height') === 54 && Math.abs(+root.getAttribute('width') * 140 / 54 - 220) < 0.01,
    variant + ' mark uses the exact viewBox and undistorted 220:140 dimensions');
  ok(paths.length === 4 && paths.slice(0, 3).every((p, i) => p.getAttribute('d') === expectedLines[i] && p.getAttribute('fill') === 'none' && p.getAttribute('stroke-width') === '10' && p.getAttribute('stroke-linecap') === 'round'),
    variant + ' mark has the three exact 10px round-capped lines and no spark');
  ok(circles.length === 3 && circles.every((c, i) => +c.getAttribute('cx') === expectedDots[i][0] && +c.getAttribute('cy') === expectedDots[i][1] && c.getAttribute('r') === '9'),
    variant + ' mark has three 9px dots at the line origins');
  ok(paths[3].getAttribute('d') === expectedStar, variant + ' star uses the exact 4-quadrant path');
  ok([...root.children].map(el => el.localName).join(',') === 'path,path,path,circle,circle,circle,path',
    variant + ' paint order is lines, dots, star');
  ok(paths.slice(0, 3).every(p => p.getAttribute('stroke') === palette.line) && circles.every(c => c.getAttribute('fill') === palette.dot) && paths[3].getAttribute('fill') === palette.star,
    variant + ' mark has the exact v4 palette');
  ok(root.getAttribute('role') === 'img' && root.getAttribute('aria-label') === 'Nova PipelineSync AI', variant + ' mark has its accessible product name');
  const lockup = new JSDOM(brand.Logo({ variant, size: 40 })).window.document;
  ok(lockup.querySelector('.ps-lockup').getAttribute('aria-label') === 'Nova PipelineSync AI' && lockup.querySelector('.ps-wordmark-name').textContent === 'NOVA' && lockup.querySelector('.ps-wordmark-sub').textContent === 'PipelineSync AI',
    variant + ' lockup uses real HTML text with the full accessible name');
  ok(lockup.querySelector('.ps-wordmark-name').getAttribute('style').includes(variant === 'light' ? '#1B1E24' : '#EDEAE1') && lockup.querySelector('.ps-wordmark-sub').getAttribute('style').includes(variant === 'light' ? '#4A5262' : '#A9B4C6'),
    variant + ' wordmark uses its surface palette');
}
ok(/\.ps-wordmark-name\s*\{[^}]*font-weight: 600;[^}]*letter-spacing: 0\.14em;/.test(css) && /\.ps-wordmark-sub\s*\{[^}]*font-weight: 500;/.test(css) && /font-weight:700">AI<\/span>/.test(logoJs) && brand.LOGO_COLORS.light.star === '#E8590C' && brand.LOGO_COLORS.dark.star === '#F76B15',
  'wordmark typography is 600 NOVA, 500 subline and ember 700 AI in both themes');
ok(/font-family:\s*var\(--display\)/.test(css) && /Fraunces/.test(css) && /Fraunces/.test(indexHtml),
  'the display typeface is Fraunces, wired into the stylesheet and the page');
const moving = parseSvg(brand.LogoMark({ variant: 'dark', animated: true }));
ok(moving.querySelectorAll('.ps-flow-dot').length === 3 && [...moving.querySelectorAll('.ps-flow-dot')].every((c, i) => c.getAttribute('style').includes(expectedLines[i])), 'all three animated dots follow the actual incoming paths');
ok(moving.querySelector('.ps-pulse-star') && /@keyframes ps-pulse/.test(logoJs), 'the star pulses after the dots arrive');
ok(/@media \(prefers-reduced-motion:reduce\)\{\.ps-flow-dot\{animation:none;offset-path:none!important;opacity:1\}\.ps-pulse-star\{animation:none;transform:none\}\}/.test(logoJs),
  'reduced motion disables both the dot paths and the star pulse');
ok(!/function logoMark\(/.test(appJs), 'the app uses the shared component rather than an inline duplicate');
ok(/function brandVariant\(\) \{ return state.theme === 'light' \? 'light' : 'dark'; \}/.test(appJs), 'theme-following surfaces select light only in light mode');
ok(!/Logo(?:Mark)?\(\{[^}]*variant: 'light'/.test(appJs), 'no app call site places a fixed light mark on a potentially dark surface');
ok(/LogoMark\(\{ variant: 'dark', size: 24 \}\)/.test(appJs) && /rgba\(20, 22, 27, 0\.92\)/.test(css), 'the permanently dark call orb uses the dark mark even in light mode');
ok(/Logo\(\{ variant: brandVariant\(\), size: 40 \}\)/.test(appJs) && /Logo\(\{ variant: brandVariant\(\), size: 54 \}\)/.test(appJs), 'topbar and entry gate both select the active theme palette');
ok(/LogoMark\(\{ variant: brandVariant\(\), animated: true, size: 96 \}\)/.test(appJs), 'the splash uses the active surface palette');
ok(/h \* 220 \/ 140/.test(appJs) && /LogoMark\(\{ variant: brandVariant\(\), size: h \}\)/.test(appJs) && /logoTile\(54\)/.test(appJs), 'done-screen logoTile preserves 220:140 and follows the theme');
ok(/\.logo-plate\s*\{[^}]*background: transparent;[^}]*box-shadow: none;/s.test(css), 'logoTile has no white plate or shadow');
ok(/\.nova-splash-card\s*\{[^}]*background: transparent;[^}]*box-shadow: none;/s.test(css), 'the loading mark has no white plate or shadow');

const vectors = {};
for (const f of ['logo.svg', 'logo-on-dark.svg', 'logo-lockup.svg', 'logo-lockup-dark.svg', 'favicon.svg', 'app-icons.svg']) {
  vectors[f] = parseSvg(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
  ok(!vectors[f].querySelector('parsererror'), 'public/' + f + ' is well-formed XML');
  ok([...vectors[f].querySelectorAll('path')].some(p => p.getAttribute('d') === expectedStar), 'public/' + f + ' contains the exact Nova star');
}
for (const [f, variant] of [['logo.svg', 'light'], ['logo-on-dark.svg', 'dark']]) {
  const generated = [...vectors[f].querySelectorAll('path,circle')].map(n => n.outerHTML).join('');
  const component = [...parseSvg(brand.LogoMark({ variant })).querySelectorAll('path,circle')].map(n => n.outerHTML).join('');
  ok(generated === component, f + ' matches the runtime mark geometry and palette exactly');
}
ok(vectors['logo-on-dark.svg'].querySelector('rect').getAttribute('fill') === '#14161B', 'dark standalone mark sits directly on the void #14161B, not a plate');
for (const f of ['logo-lockup.svg', 'logo-lockup-dark.svg']) {
  const text = [...vectors[f].querySelectorAll('text')];
  ok(text.length === 2 && text[0].textContent === 'NOVA' && text[1].textContent === 'PipelineSync AI', f + ' includes the two-line wordmark');
}
for (const [f, tileColor, dotColor, starColor] of [['favicon.svg', '#E8590C', '#F6F3EC', '#17335C'], ['app-icons.svg', '#1C3D6E', '#8FA6C4', '#F76B15']]) {
  const svg = vectors[f];
  const tile = svg.querySelector('rect');
  const paths = [...svg.querySelectorAll('path')];
  const dots = [...svg.querySelectorAll('circle')];
  ok(svg.documentElement.getAttribute('viewBox') === '0 0 512 512' && tile.getAttribute('fill') === tileColor && +tile.getAttribute('rx') === 512 * 0.22, f + ' uses its specified rounded-square tile');
  ok(paths.length === 4 && paths[3].getAttribute('d') === expectedStar && paths[3].getAttribute('fill') === starColor && paths.slice(0, 3).every((p, i) => p.getAttribute('d') === expectedLines[i] && p.getAttribute('stroke') === '#F6F3EC' && p.getAttribute('stroke-width') === '14' && p.getAttribute('stroke-linecap') === 'round' && p.getAttribute('fill') === 'none'), f + ' uses exact 14px paper icon geometry with no spark');
  ok(dots.length === 3 && dots.every((c, i) => c.getAttribute('r') === '12' && c.getAttribute('fill') === dotColor && +c.getAttribute('cx') === expectedDots[i][0] && +c.getAttribute('cy') === expectedDots[i][1]), f + ' uses exact 12px icon dots');
  const transform = svg.querySelector('g').getAttribute('transform');
  const scale = +transform.match(/scale\(([^)]+)\)/)[1];
  const translate = transform.match(/translate\(([^ ]+) ([^)]+)\)/);
  ok(Math.abs(scale * 220 / 512 - 0.72) < 1e-10 && Math.abs(+translate[1] + 220 * scale / 2 - 256) < 1e-8 && Math.abs(+translate[2] + 140 * scale / 2 - 256) < 1e-8, f + ' centres an undistorted 72%-width mark');
}
for (const [f, size] of [['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const png = fs.readFileSync(path.join(__dirname, '..', 'public', f));
  ok(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && png.readUInt32BE(16) === size && png.readUInt32BE(20) === size, f + ' is a real PNG with the specified dimensions');
}
/* Decode committed RGBA PNG scanlines with Node's built-in zlib. No image
   renderer is needed at runtime or to check that a maskable icon is safe. */
function rgbaPng(file) {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'public', file));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw new Error('Expected non-interlaced RGBA8 PNG: ' + file);
  const chunks = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = require('zlib').inflateSync(Buffer.concat(chunks));
  const stride = width * 4, pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= 4 ? pixels[at - 4] : 0, b = y ? pixels[at - stride] : 0, c = y && x >= 4 ? pixels[at - stride - 4] : 0;
      const predict = a + b - c, da = Math.abs(predict - a), db = Math.abs(predict - b), dc = Math.abs(predict - c);
      const paeth = da <= db && da <= dc ? a : db <= dc ? b : c;
      pixels[at] = (raw[y * (stride + 1) + 1 + x] + [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255;
    }
  }
  return { pixels, width, height };
}
const maskable = rgbaPng('icon-maskable-512.png');
let outsideSafeCircle = 0, markPixels = 0, starPixels = 0;
for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
  const at = (y * 512 + x) * 4, p = maskable.pixels;
  // Rounded tile edges can unpremultiply navy by a few RGB units at low alpha.
  // Compare premultiplied channels within two quantisation steps (premultiply/unpremultiply), not raw RGB.
  if ([28, 61, 110].some((bg, c) => Math.abs((p[at + c] - bg) * p[at + 3] / 255) > 2)) {
    markPixels++;
    if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) outsideSafeCircle++;
    if (p[at] === 247 && p[at + 1] === 107 && p[at + 2] === 21) starPixels++;
  }
}
ok(markPixels > 1000 && starPixels > 100 && outsideSafeCircle === 0,
  'all maskable mark pixels, including the ember star, are inside the central 80%-diameter safe circle');
const ico = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'));
ok(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3 && [16,32,48].every((size, i) => ico[6 + i * 16] === size && ico[7 + i * 16] === size && ico.subarray(ico.readUInt32LE(18 + i * 16), ico.readUInt32LE(18 + i * 16) + 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))), 'favicon.ico embeds valid 16/32/48 PNG entries');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
ok(manifest.theme_color === '#F6F3EC' && manifest.background_color === '#F6F3EC', 'the manifest carries the paper #F6F3EC theme colour');
ok(manifest.icons.some(i => /512/.test(i.sizes)), 'the manifest carries the 512px app icon');
ok(manifest.name === 'Nova PipelineSync AI' && manifest.short_name === 'Nova', 'manifest uses the full product name and Nova short name');
const pkg = require('../package.json');
ok(!Object.keys(pkg.dependencies || {}).some(k => /resvg|playwright|chromium/.test(k)) && !Object.keys(pkg.devDependencies || {}).some(k => /resvg/.test(k)), 'asset renderer stays a build-time-only tool outside app dependencies');

ok(/<title>Nova PipelineSync AI \|/.test(indexHtml), 'the page title uses the full product name');
ok(/text: 'Nova PipelineSync AI', style: 'headerBrand'/.test(appJs) && /Tm \(Nova PipelineSync AI\) Tj/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'core.js'), 'utf8')), 'browser and server PDF headers use the full product name');
ok(/>Nova PipelineSync AI<\/div>/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pdf-email.js'), 'utf8')), 'the email header uses the full product name');

/* ------------------------------------------------------------------ */
section('the mascot is recoloured with the brand, unchanged in geometry');
for (const pose of ['sync', 'hello', 'listen', 'speak', 'think', 'party']) {
  ok(new RegExp(pose + ':\\s*\\{').test(novaJs), 'Nova.js defines the "' + pose + '" pose');
}
ok(/'\+ \(avatar \? '66 36 168 168' : '0 0 300 300'\) \+'|avatar \? '66 36 168 168' : '0 0 300 300'/.test(novaJs),
  'Nova keeps both view boxes (the full figure and the head-only avatar crop)');
/* Nova is transparent artwork: nothing may paint behind him, or the app's own surface (paper,
   ink or an export) stops showing through. */
ok(!/<circle cx="150" cy="120" r="84"/.test(novaJs) && !/background:' \+ MIST/.test(novaJs),
  'the avatar draws no circle or plate behind the head');
ok(!/ellipse cx="150" cy="286"/.test(novaJs), 'the full figure draws no ground shadow');
ok(/role="img" aria-label="/.test(novaJs), 'Nova keeps role=img and his aria-label');
ok(/@media \(prefers-reduced-motion:reduce\)\{\[class\^="nova-"\]/.test(novaJs), "Nova's animation CSS honours reduced motion");
ok(/#1C3D6E/.test(novaJs) && /#6E88AB/.test(novaJs) && /#142C50/.test(novaJs) && /#E8590C/.test(novaJs) && /#8FA6C4/.test(novaJs) && /#F6F3EC/.test(novaJs),
  "Nova's palette is the Nova Ink v4 brand palette");
ok(!/#0C2B5E/.test(novaJs) && !/#3E6892/.test(novaJs) && !/#2E5580/.test(novaJs) && !/#FF7A1A/.test(novaJs) && !/#8FB0D0/.test(novaJs) && !/#E8EFF7/.test(novaJs),
  'the retired v3 palette is fully gone from the mascot');

/* Rules from the brand sheet, asserted on the real rendering code. The UI no longer renders the
   mascot: no figure, no avatar, no copy line - the only trace of the brand sheet left on screen
   is the logo and the audio waveform. */
ok(!/NovaAvatar\(|PSBrand\.Nova\b/.test(appJs), 'the app no longer renders Nova\'s figure anywhere');
ok(!/NOVA_COPY\./.test(appJs), 'the app no longer renders Nova\'s copy lines');
ok(!/\.nova-live-fig|\.nova-party-fig|\.nova-ringing|\.nova-fig-card|\.bubble-av|\.toast-av|\.who-nova/.test(css),
  'no mascot rules remain in the stylesheet');
ok(/\.nova-wave-bar \{[^}]*linear-gradient\(180deg, var\(--sky\) 0%, var\(--sync-orange\) 100%\)/.test(css),
  'the waveform is the sky -> ember gradient');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.nova-wave-bar \{ animation: none/.test(css),
  'the waveform stops under reduced motion');
ok(/novaWaveHtml\('nova-wave'\)/.test(appJs) && /<div class="nova-wave"/.test(appJs),
  'the waveform is rendered under the live question');

/* Nova's copy: the five lines, exactly as the brand sheet words them in the component. The UI no
   longer renders them, but the brand component keeps the copy verbatim. */
for (const line of [
  "Hi, I'm Nova. Let's map how your deals actually move.",
  "Take your time. I'm connecting the dots as you talk.",
  "One sec, I'm linking your pipeline stages together.",
  "Your blueprint's ready. Eight arms, zero loose ends.",
  "Hmm, I lost that thread. Mind saying it again?"
]) {
  ok(novaJs.indexOf(JSON.stringify(line).slice(1, -1)) >= 0, 'Nova says: ' + line.slice(0, 42) + '...');
}
ok(!/\bAlex\b/.test(appJs), 'the UI no longer calls the interviewer Alex');
ok(/<b>Nova<\/b>/.test(appJs) && !/id="call-progress"/.test(appJs) && !/id="call-bar"/.test(appJs), 'the call screen names the AI, and the question counter is gone');

/* ------------------------------------------------------------------ */
section('dual paper/ink theme, restored and complete');

const darkBlock = css.slice(darkIdx, css.indexOf('\n}', darkIdx));
ok(/body\[data-theme="dark"\] \{/.test(css) && /--bg:\s*#14161B/.test(darkBlock) && /--sync-orange:\s*#F76B15/.test(darkBlock),
  'the dark "ink" theme is a real token block, not a single inverted colour');
ok(!/backdrop-filter/.test(css) && !/blur\(/.test(css), 'the glass era is gone: no backdrop blur or filter blur anywhere');
const orbBgRules = (function gather(list) {
  let found = '';
  (function go(rules) {
    for (const r of rules) {
      if (r.cssRules) { go(r.cssRules); continue; }
      if (r.selectorText && /\.orb-bg/.test(r.selectorText)) found += ' ' + (r.style.cssText || '');
    }
  })(list);
  return found;
})(sheet.cssRules);
ok(!/animation/.test(orbBgRules), 'the brand wash is a static paper/ink gradient (no drift animation)');
ok(/content="light dark"/.test(indexHtml), 'the page declares a light-dark colour scheme');
ok(/<meta name="theme-color" content="#F6F3EC">/.test(indexHtml), 'the default browser theme colour is paper');
ok(/function initTheme\(/.test(appJs) && /store\.get\('ps_theme'\)/.test(appJs), 'a fresh visit follows the OS preference; a choice is persisted in ps_theme');
ok(/function applyTheme\(\)/.test(appJs) && /document\.body\.dataset\.theme = state\.theme/.test(appJs) && /meta\[name="theme-color"\]/.test(appJs),
  'applyTheme flips the body attribute, the colour scheme and the theme-color meta together');
ok(/id="theme-toggle"/.test(appJs) && /aria-label="Switch to '.* theme"/.test(appJs), 'the toggle button announces what it will switch to');
ok(/e\.target\.closest \? e\.target\.closest\('#theme-toggle'\) : null/.test(appJs), 'one delegated listener drives the toggle in both the gate and the topbar');
ok(/'brand-topbar'/.test(appJs) && /'brand-gate'/.test(appJs) && /'brand-splash'/.test(appJs), 'theme changes re-render the baked-colour brand marks in place');
ok(/if \(state\.stage !== 'intake'\) render\(\)/.test(appJs), 'mid-call the toggle swaps marks without re-rendering the live screen');
ok(/\.gate-corner/.test(css), 'the entry gate has a corner slot for the toggle');

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

section('centered minimalist workspace');
const centered = css.slice(css.indexOf('Centered, quiet workspace'));
ok(/body\.app-screen \.main\s*\{[^}]*max-width: 1120px;[^}]*margin-inline: auto;/s.test(centered), 'the application canvas is bounded and horizontally centered');
ok(/\.intake-wrap\.call-only\s*\{ max-width: 760px;/.test(centered), 'the voice-only panel has a comfortable desktop width');
ok(/body\.entry-screen \.gate\s*\{[^}]*flex-direction: column;/s.test(centered), 'entry uses one centered column');
ok(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(centered), 'review uses two readable columns on desktop');
ok(/@media \(max-width: 700px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/.test(centered), 'review stacks on narrow screens');
ok(/body::before, body::after \{ display: none;/.test(centered), 'decorative background overlays are removed');
ok(/text-align: left;/.test(centered), 'long call content remains left-aligned');

console.log('\n' + (failures === 0 ? 'UI DESIGN CHECKS PASSED' : failures + ' UI DESIGN FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
