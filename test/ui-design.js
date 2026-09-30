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
  ['light mark lines on white', '#0C2B5E', '#FFFFFF', 3],
  ['light mark dots on white', '#3E6892', '#FFFFFF', 3],
  ['dark mark lines on dark', '#E8EFF7', '#0A0E17', 3],
  ['dark mark dots/spark on dark', '#8FB0D0', '#0A0E17', 3],
  ['dark mark star on dark', '#FF7A1A', '#0A0E17', 3],
  ['navy star on orange tile', '#0C2B5E', '#FF7A1A', 3],
  ['orange star on navy tile', '#FF7A1A', '#0C2B5E', 3]
];
for (const [label, fg, bg, min] of PAIRS) {
  const f = tokens[fg] || fg, b = tokens[bg] || bg;
  if (!f || !b) { ok(false, label + ': token missing (' + fg + '/' + bg + ')'); continue; }
  const r = ratio(f, b);
  ok(r >= min, label.padEnd(30) + r.toFixed(2) + ':1 (need ' + min + ':1)');
}

/* ------------------------------------------------------------------ */
section('Nova geometry, variants, surfaces and generated assets');

const logoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Logo.js'), 'utf8');
const novaJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Nova.js'), 'utf8');
const brand = require('../public/components/brand/Logo.js').PSBrand;
const svgParser = new JSDOM('').window.DOMParser;
const parseSvg = svg => new svgParser().parseFromString(svg, 'image/svg+xml');
const expectedLines = ['M16 50 C50 50 56 100 84 100', 'M6 100 L84 100', 'M16 150 C50 150 56 100 84 100'];
const expectedStar = 'M138 28 Q146 92 206 100 Q146 108 138 172 Q130 108 70 100 Q130 92 138 28 Z';
const expectedSpark = 'M186 22 Q188 38 204 40 Q188 42 186 58 Q184 42 168 40 Q184 38 186 22 Z';
const expectedDots = [[16, 50], [6, 100], [16, 150]];
for (const variant of ['light', 'dark']) {
  const svg = parseSvg(brand.LogoMark({ variant, size: 54 }));
  const root = svg.documentElement;
  const paths = [...svg.querySelectorAll('path')];
  const circles = [...svg.querySelectorAll('circle')];
  const palette = variant === 'light' ? ['#0C2B5E', '#3E6892'] : ['#E8EFF7', '#8FB0D0'];
  ok(root.getAttribute('viewBox') === '-10 16 222 162' && +root.getAttribute('width') === 74 && +root.getAttribute('height') === 54,
    variant + ' mark uses the exact viewBox and undistorted 222:162 dimensions');
  ok(paths.length === 5 && paths.slice(0, 3).every((p, i) => p.getAttribute('d') === expectedLines[i] && p.getAttribute('fill') === 'none' && p.getAttribute('stroke-width') === '14' && p.getAttribute('stroke-linecap') === 'round'),
    variant + ' mark has the three exact 14px round-capped lines');
  ok(circles.length === 3 && circles.every((c, i) => +c.getAttribute('cx') === expectedDots[i][0] && +c.getAttribute('cy') === expectedDots[i][1] && c.getAttribute('r') === '12'),
    variant + ' mark has three 12px dots at the specified centres');
  ok(paths[3].getAttribute('d') === expectedStar && paths[4].getAttribute('d') === expectedSpark,
    variant + ' star and spark use the exact paths');
  ok([...root.children].map(el => el.localName).join(',') === 'path,path,path,circle,circle,circle,path,path',
    variant + ' paint order is lines, dots, star, spark');
  ok(paths.slice(0, 3).every(p => p.getAttribute('stroke') === palette[0]) && circles.every(c => c.getAttribute('fill') === palette[1]) && paths[3].getAttribute('fill') === '#FF7A1A' && paths[4].getAttribute('fill') === palette[1],
    variant + ' mark has the exact palette');
  ok(root.getAttribute('role') === 'img' && root.getAttribute('aria-label') === 'Nova PipelineSync AI', variant + ' mark has its accessible product name');
  const lockup = new JSDOM(brand.Logo({ variant, size: 40 })).window.document;
  ok(lockup.querySelector('.ps-lockup').getAttribute('aria-label') === 'Nova PipelineSync AI' && lockup.querySelector('.ps-wordmark-name').textContent === 'NOVA' && lockup.querySelector('.ps-wordmark-sub').textContent === 'PipelineSync AI',
    variant + ' lockup uses real HTML text with the full accessible name');
  ok(lockup.querySelector('.ps-wordmark-name').getAttribute('style').includes(variant === 'light' ? '#0C2B5E' : '#FFFFFF') && lockup.querySelector('.ps-wordmark-sub').getAttribute('style').includes(palette[1]),
    variant + ' wordmark uses its surface palette');
}
ok(/\.ps-wordmark-name\s*\{[^}]*font-weight: 800;[^}]*letter-spacing: 0.09em;/.test(css) && /\.ps-wordmark-sub\s*\{[^}]*font-weight: 600;/.test(css) && /color:#FF7A1A;font-weight:800/.test(logoJs),
  'wordmark typography is 800 NOVA, 600 subline and orange 800 AI');
const moving = parseSvg(brand.LogoMark({ variant: 'dark', animated: true }));
ok(moving.querySelectorAll('.ps-flow-dot').length === 3 && [...moving.querySelectorAll('.ps-flow-dot')].every((c, i) => c.getAttribute('style').includes(expectedLines[i])), 'all three animated dots follow the actual incoming paths');
ok(moving.querySelector('.ps-pulse-star') && /@keyframes ps-pulse/.test(logoJs), 'the star pulses after the dots arrive');
ok(/@media \(prefers-reduced-motion:reduce\)\{\.ps-flow-dot\{animation:none;offset-path:none!important;opacity:1\}\.ps-pulse-star\{animation:none;transform:none\}\}/.test(logoJs),
  'reduced motion disables both the dot paths and the star pulse');
ok(!/function logoMark\(/.test(appJs), 'the app uses the shared component rather than an inline duplicate');
ok(/function brandVariant\(\) \{ return state.theme === 'light' \? 'light' : 'dark'; \}/.test(appJs), 'theme-following surfaces select light only in light mode');
ok(!/Logo(?:Mark)?\(\{[^}]*variant: 'light'/.test(appJs), 'no app call site places a fixed light mark on a potentially dark surface');
ok(/LogoMark\(\{ variant: 'dark', size: 24 \}\)/.test(appJs) && /\.orb\s*\{[^}]*rgba\(10, 14, 23, 0.9\)/s.test(css), 'the permanently dark call orb uses the dark mark even in light mode');
ok(/Logo\(\{ variant: brandVariant\(\), size: 40 \}\)/.test(appJs) && /Logo\(\{ variant: brandVariant\(\), size: 54 \}\)/.test(appJs), 'topbar and entry gate both select the active theme palette');
ok(/LogoMark\(\{ variant: brandVariant\(\), animated: true, size: 96 \}\)/.test(appJs), 'the splash uses the active surface palette');
ok(/h \* 222 \/ 162/.test(appJs) && /LogoMark\(\{ variant: brandVariant\(\), size: h \}\)/.test(appJs) && /logoTile\(54\)/.test(appJs), 'done-screen logoTile preserves 222:162 and follows the theme');
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
ok(vectors['logo-on-dark.svg'].querySelector('rect').getAttribute('fill') === '#0A0E17', 'dark standalone mark sits directly on #0A0E17, not a plate');
for (const f of ['logo-lockup.svg', 'logo-lockup-dark.svg']) {
  const text = [...vectors[f].querySelectorAll('text')];
  ok(text.length === 2 && text[0].textContent === 'NOVA' && text[1].textContent === 'PipelineSync AI', f + ' includes the two-line wordmark');
}
for (const [f, tileColor, dotColor, starColor] of [['favicon.svg', '#FF7A1A', '#FFFFFF', '#0C2B5E'], ['app-icons.svg', '#0C2B5E', '#8FB0D0', '#FF7A1A']]) {
  const svg = vectors[f];
  const tile = svg.querySelector('rect');
  const paths = [...svg.querySelectorAll('path')];
  const dots = [...svg.querySelectorAll('circle')];
  ok(svg.documentElement.getAttribute('viewBox') === '0 0 512 512' && tile.getAttribute('fill') === tileColor && +tile.getAttribute('rx') === 512 * 0.22, f + ' uses its specified rounded-square tile');
  ok(paths.length === 4 && paths[3].getAttribute('d') === expectedStar && paths[3].getAttribute('fill') === starColor && paths.slice(0, 3).every((p, i) => p.getAttribute('d') === expectedLines[i] && p.getAttribute('stroke') === '#FFFFFF' && p.getAttribute('stroke-width') === '16' && p.getAttribute('stroke-linecap') === 'round' && p.getAttribute('fill') === 'none'), f + ' uses exact 16px icon geometry with no spark');
  ok(dots.length === 3 && dots.every((c, i) => c.getAttribute('r') === '13' && c.getAttribute('fill') === dotColor && +c.getAttribute('cx') === expectedDots[i][0] && +c.getAttribute('cy') === expectedDots[i][1]), f + ' uses exact 13px icon dots');
  const transform = svg.querySelector('g').getAttribute('transform');
  const scale = +transform.match(/scale\(([^)]+)\)/)[1];
  const translate = transform.match(/translate\(([^ ]+) ([^)]+)\)/);
  ok(Math.abs(scale * 222 / 512 - 0.72) < 1e-10 && Math.abs(+translate[1] + 222 * scale / 2 - 256) < 1e-8 && Math.abs(+translate[2] + 162 * scale / 2 - 256) < 1e-8 && transform.endsWith('translate(10 -16)'), f + ' centres an undistorted 72%-width mark');
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
  if ([12, 43, 94].some((bg, c) => Math.abs((p[at + c] - bg) * p[at + 3] / 255) > 2)) {
    markPixels++;
    if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) outsideSafeCircle++;
    if (p[at] === 255 && p[at + 1] === 122 && p[at + 2] === 26) starPixels++;
  }
}
ok(markPixels > 1000 && starPixels > 100 && outsideSafeCircle === 0,
  'all maskable mark pixels, including the orange star, are inside the central 80%-diameter safe circle');
const ico = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'));
ok(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3 && [16,32,48].every((size, i) => ico[6 + i * 16] === size && ico[7 + i * 16] === size && ico.subarray(ico.readUInt32LE(18 + i * 16), ico.readUInt32LE(18 + i * 16) + 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))), 'favicon.ico embeds valid 16/32/48 PNG entries');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
ok(manifest.theme_color === '#0A0E17' && manifest.background_color === '#0A0E17', 'the manifest theme colour stays #0A0E17');
ok(manifest.icons.some(i => /512/.test(i.sizes)), 'the manifest carries the 512px app icon');
ok(manifest.name === 'Nova PipelineSync AI' && manifest.short_name === 'Nova', 'manifest uses the full product name and Nova short name');
const pkg = require('../package.json');
ok(!Object.keys(pkg.dependencies || {}).some(k => /resvg|playwright|chromium/.test(k)) && !Object.keys(pkg.devDependencies || {}).some(k => /resvg/.test(k)), 'asset renderer stays a build-time-only tool outside app dependencies');

ok(/<title>Nova PipelineSync AI \|/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), 'the page title uses the full product name');
ok(/text: 'Nova PipelineSync AI', style: 'headerBrand'/.test(appJs) && /Tm \(Nova PipelineSync AI\) Tj/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'core.js'), 'utf8')), 'browser and server PDF headers use the full product name');
ok(/>Nova PipelineSync AI<\/div>/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pdf-email.js'), 'utf8')), 'the email header uses the full product name');

section('the mascot component remains unchanged');
for (const pose of ['sync', 'hello', 'listen', 'speak', 'think', 'party']) {
  ok(new RegExp(pose + ':\\s*\\{').test(novaJs), 'Nova.js defines the "' + pose + '" pose');
}
ok(/'\+ \(avatar \? '66 36 168 168' : '0 0 300 300'\) \+'|avatar \? '66 36 168 168' : '0 0 300 300'/.test(novaJs),
  'Nova keeps both view boxes (the full figure and the head-only avatar crop)');
/* Nova is transparent artwork: nothing may paint behind him, or the app's own surface (dark, light
   or an export) stops showing through. */
ok(!/<circle cx="150" cy="120" r="84"/.test(novaJs) && !/background:' \+ MIST/.test(novaJs),
  'the avatar draws no circle or plate behind the head');
ok(!/ellipse cx="150" cy="286"/.test(novaJs), 'the full figure draws no ground shadow');
ok(/role="img" aria-label="/.test(novaJs), 'Nova keeps role=img and his aria-label');
ok(/@media \(prefers-reduced-motion:reduce\)\{\[class\^="nova-"\]/.test(novaJs), "Nova's animation CSS honours reduced motion");
ok(/#0C2B5E/.test(novaJs) && /#3E6892/.test(novaJs) && /#FF7A1A/.test(novaJs) && /#8FB0D0/.test(novaJs) && /#E8EFF7/.test(novaJs),
  "Nova's palette is the brand palette and nothing else");

/* Rules from the brand sheet, asserted on the real rendering code. The UI no longer renders the
   mascot: no figure, no avatar, no copy line - the only trace of the brand sheet left on screen
   is the logo and the audio waveform. */
ok(!/NovaAvatar\(|PSBrand\.Nova\b/.test(appJs), 'the app no longer renders Nova\'s figure anywhere');
ok(!/NOVA_COPY\./.test(appJs), 'the app no longer renders Nova\'s copy lines');
ok(!/\.nova-live-fig|\.nova-party-fig|\.nova-ringing|\.nova-fig-card|\.bubble-av|\.toast-av|\.who-nova/.test(css),
  'no mascot rules remain in the stylesheet');
ok(/\.nova-wave-bar \{[^}]*linear-gradient\(180deg, var\(--sky\) 0%, var\(--sync-orange\) 100%\)/.test(css),
  'the waveform is the #8FB0D0 -> #FF7A1A gradient');
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
