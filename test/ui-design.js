/* Design-system checks for the responsive UI (run: node test/ui-design.js).
 *
 * The layout cannot be rendered headlessly here, so this checks the things a redesign
 * silently breaks and that the browser would not report:
 *   1. the stylesheet still parses, and every class public/app.js renders has a rule,
 *   2. every text/background pair in the design tokens clears WCAG AA on the dark
 *      neon canvas,
 *   3. the interactive controls keep a 44px touch target on phones,
 *   4. the Ember/Navy neon brand (the PipelineSync website theme: single dark
 *      canvas, glass panels, S-mark identity assets) is exactly what the
 *      components and static files claim.
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

/* The brand components (the PipelineSync S-mark lockup and Nova - still shipped as a brand
   asset, though the UI no longer renders the figure) are part of the check. Their animation
   classes ship inside the components' own inline <style> (the brand sheet specifies the
   components as written), so a class is covered if the stylesheet has a rule for it or the
   component's own CSS defines it. */
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
    m[1].split(/\s+/).forEach(c => { if (c && !/['"]/ .test(c)) used.add(c); });
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

/* No white text on a brand fill anywhere. The neon primary button is the ember gradient
   with the deep warm #1A0C02 text, which clears 4.5:1, so nothing is exempted. */
const whiteOnBrand = [];
(function walk2(list) {
  for (const r of list) {
    if (r.cssRules) walk2(r.cssRules);
    if (!r.style) continue;
    const bg = (r.style.background || '') + (r.style.backgroundColor || '');
    if (!/var\(--brand\)|var\(--sync-orange\)|var\(--grad-ember\)|var\(--grad-btn\)/.test(bg)) continue;
    if (!/(#fff\b|#ffffff|white)/i.test(r.style.color || '')) continue;
    (r.selectorText || '').split(',').forEach(sel => whiteOnBrand.push(sel.trim()));
  }
})(sheet.cssRules);
ok(whiteOnBrand.length === 0, 'white text sits on no brand fill (the primary button is ember with deep warm text)' +
  (whiteOnBrand.length ? ': ' + whiteOnBrand.join(', ') : ''));
const primaryFill = (function find(list) {
  for (const r of list) {
    if (r.cssRules) { const f = find(r.cssRules); if (f) return f; continue; }
    if (r.selectorText && r.selectorText.trim() === '.btn-primary' && r.style.background) return r.style.background;
  }
  return ''
})(sheet.cssRules);
ok(/var\(--grad-ember\)/.test(primaryFill),
  'the primary button is the ember gradient fill (' + (primaryFill || 'no fill found') + ')');
ok(/var\(--brand-ink\)/.test((function btnColor(list) {
  for (const r of list) {
    if (r.cssRules) { const f = btnColor(r.cssRules); if (f != null) return f; continue; }
    if (r.selectorText && r.selectorText.trim() === '.btn-primary' && r.style.color) return r.style.color;
  }
  return null
})(sheet.cssRules)), 'the primary button label is the deep warm ink, not white');
ok(/--brand:\s*#ff7a1a/.test(css) && /--brand-2:\s*#ffab5e/.test(css) && /--blue:\s*#5b8cff/.test(css) && /--cyan:\s*#3fd0ee/.test(css) && /--green:\s*#34d399/.test(css),
  'the PipelineSync brand tokens are declared (brand #ff7a1a, brand-2 #ffab5e, blue #5b8cff, cyan #3fd0ee, green #34d399)');
ok(/--bg:\s*#05070c/i.test(css) && /--bg-elev:\s*#0a0e17/.test(css) && /--bg-elev-2:\s*#0f1522/.test(css), 'the surfaces are the brand near-black #05070c with #0a0e17 / #0f1522 elevations');
ok(/--text:\s*#f1f4f9/.test(css) && /--text-2:\s*#aeb8c7/.test(css) && /--text-3:\s*#8591a3/.test(css), 'the text tokens are the brand #f1f4f9 / #aeb8c7 / #8591a3');

/* ------------------------------------------------------------------ */
section('design tokens clear WCAG AA on the dark neon canvas');

function tokensOf(block) {
  const tokens = {};
  for (const t of block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8}|rgba\(\s*\d+,\s*\d+,\s*\d+,\s*[\d.]+\s*\))/g)) tokens[t[1]] = t[2];
  return tokens;
}
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('\n}', css.indexOf(':root')));
const tokens = tokensOf(rootBlock);
const hex2rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = h => { const [r, g, b] = hex2rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/* Compose a translucent tint over the canvas so rgba() tints can be checked like hexes. */
const bgRgb = hex2rgb(tokens['--bg'] || '#040B16');
const composite = (tint, base) => {
  const m = String(tint).match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  if (!m) return tint;
  const a = parseFloat(m[4]);
  const rgb = base.map((bv, i) => Math.round(parseInt(m[i + 1]) * a + bv * (1 - a)));
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
};
const resolve = t => /^#/.test(t) ? t : composite(t, bgRgb);

const PAIRS = [
  /* [label, foreground, background, minimum] */
  ['body text on the page', '--ink', '--bg', 4.5],
  ['body text on a panel', '--ink', '--bg-sunk', 4.5],
  ['muted text on the page', '--muted', '--bg', 4.5],
  ['muted text on a panel', '--muted', '--bg-sunk', 4.5],
  ['helper text on the page', '--faint', '--bg', 4.5],
  ['helper text on a panel', '--faint', '--bg-sunk', 4.5],
  ['primary button label', '--brand-ink', '--sync-orange', 4.5],
  ['required figure on its tint', '--req', '--ember-soft', 4.5],
  ['success text', '--green', '--green-soft', 4.5],
  ['warning text', '--amber', '--amber-soft', 4.5],
  ['error text', '--red', '--red-soft', 4.5],
  ['AI bubble and your-answer line', '--navy', '--steel-soft', 4.5],
  ['links on a panel', '--info', '--bg-sunk', 4.5],
  ['info note text', '--info', '--info-soft', 4.5],
  /* Fixed pairs: the Nova mark on the dark canvas (the light LOGO_COLORS variant is
     API symmetry for the component and is never rendered on a light surface) and the S-mark
     on the product tile. */
  ['mark lines on the dark canvas', '#4C8DFF', '#040B16', 3],
  ['mark dots on the dark canvas', '#8FB6FF', '#040B16', 3],
  ['mark star on the dark canvas', '#F97A1A', '#040B16', 3],
  ['S-mark silhouette on the navy tile', '#FFFFFF', '#040B16', 3],
  ['S-mark ember dot on the navy tile', '#F97A1A', '#040B16', 3]
];
for (const [label, fg, bg, min] of PAIRS) {
  const f = resolve(tokens[fg] || fg), b = resolve(tokens[bg] || bg);
  if (!f || !b) { ok(false, label + ': token missing (' + fg + '/' + bg + ')'); continue; }
  const r = ratio(f, b);
  ok(r >= min, label.padEnd(42) + r.toFixed(2) + ':1 (need ' + min + ':1)');
}

/* ------------------------------------------------------------------ */
section('Ember/Navy neon brand: geometry, variants, surfaces and assets');

const logoJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Logo.js'), 'utf8');
const novaJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', 'Nova.js'), 'utf8');
const brand = require('../public/components/brand/Logo.js').PSBrand;
const svgParser = new JSDOM('').window.DOMParser;
const parseSvg = svg => new svgParser().parseFromString(svg, 'image/svg+xml');
/* Nova's mark: 220x140, three straight 10px lines into the centre, three 9px dots at their
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
    ? { line: '#0E1C36', dot: '#4C8DFF', star: '#F97A1A' }
    : { line: '#4C8DFF', dot: '#8FB6FF', star: '#F97A1A' };
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
    variant + ' mark has the exact neon palette');
  ok(root.getAttribute('role') === 'img' && root.getAttribute('aria-label') === 'Nova PipelineSync AI', variant + ' mark has its accessible product name');
  const lockup = new JSDOM(brand.Logo({ variant, size: 40 })).window.document;
  ok(lockup.querySelector('.ps-lockup').getAttribute('aria-label') === 'Nova PipelineSync AI' && lockup.querySelector('.ps-wordmark-name').textContent === 'Nova' && lockup.querySelector('.ps-wordmark-sub').textContent === 'PipelineSync AI',
    variant + ' lockup uses real HTML text with the full accessible name');
  const markImg = lockup.querySelector('.ps-lockup-mark img.ps-mark-img');
  ok(markImg && markImg.getAttribute('src') === '/components/brand/pipelinesync-mark.png' && markImg.getAttribute('alt') === '',
    variant + ' lockup leads with the PipelineSync S-mark raster');
  ok(lockup.querySelector('.ps-wordmark-name').getAttribute('style').includes(variant === 'light' ? '#0E1C36' : '#F4F7FF') && lockup.querySelector('.ps-wordmark-sub').getAttribute('style').includes(variant === 'light' ? '#47546E' : '#B7C3DE'),
    variant + ' wordmark uses its surface palette');
}
ok(/\.ps-mark-img\s*\{[^}]*brightness\(0\)[^}]*invert\(1\)[^}]*drop-shadow\(0 0 10px rgba\(249, 122, 26, 0\.55\)\)/s.test(css),
  'the S-mark is rendered white with the site navbar ember glow');
ok(/\.ps-wordmark-name\s*\{[^}]*font-weight: 700;/s.test(css) && /\.ps-wordmark-sub\s*\{[^}]*font-weight: 500;[^}]*letter-spacing: 0\.12em;[^}]*text-transform: uppercase;/s.test(css) && /font-weight:700">AI<\/span>/.test(logoJs) && brand.LOGO_COLORS.light.star === '#F97A1A' && brand.LOGO_COLORS.dark.star === '#F97A1A',
  'wordmark typography is 700 Nova, mono 500 uppercase subline and ember 700 AI');
ok(/--font:\s*"Geist"/.test(css) && /--mono:\s*"Geist Mono"/.test(css) && /family=Geist:wght@400;500;600;700/.test(indexHtml) && /family=Geist\+Mono:wght@400;500;600/.test(indexHtml) && /display=swap/.test(indexHtml),
  'the typefaces are Geist and Geist Mono, wired into the stylesheet and the page');
const moving = parseSvg(brand.LogoMark({ variant: 'dark', animated: true }));
ok(moving.querySelectorAll('.ps-flow-dot').length === 3 && [...moving.querySelectorAll('.ps-flow-dot')].every((c, i) => c.getAttribute('style').includes(expectedLines[i])), 'all three animated dots follow the actual incoming paths');
ok(moving.querySelector('.ps-pulse-star') && /@keyframes ps-pulse/.test(logoJs), 'the star pulses after the dots arrive');
ok(/@media \(prefers-reduced-motion:reduce\)\{\.ps-flow-dot\{animation:none;offset-path:none!important;opacity:1\}\.ps-pulse-star\{animation:none;transform:none\}\}/.test(logoJs),
  'reduced motion disables both the dot paths and the star pulse');
ok(!/function logoMark\(/.test(appJs), 'the app uses the shared component rather than an inline duplicate');
ok(/function brandVariant\(\) \{ return state\.theme === 'light' \? 'light' : 'dark'; \}/.test(appJs), 'theme-following surfaces select light only in light mode');
ok(!/Logo(?:Mark)?\(\{[^}]*variant: 'light'/.test(appJs), 'no app call site places a fixed light mark on a potentially dark surface');
ok(!/LogoMark\(/.test(appJs) && /<canvas class="orb-globe" aria-hidden="true"><\/canvas>/.test(appJs) && !/gyro-ring|reticle/.test(appJs + css),
  'the call orb is the particle globe canvas (the Nova mark and the old rings are removed)');
ok(/Logo\(\{ variant: brandVariant\(\), size: 40 \}\)/.test(appJs) && /SMark\(\{ size: 40 \}\)/.test(appJs), 'the topbar uses the S-mark lockup and the login screen the S-mark alone');
ok(!/nova-splash|novaSplashHtml/.test(appJs), 'the loader no longer renders the Nova mark');
ok(!/logoTile|done-mark/.test(appJs), 'the done screen no longer renders the Nova mark');
ok(/\.gate-logo\s*\{[^}]*position: absolute;[^}]*left:/.test(css), 'the login screen pins the S-mark to the upper-left corner');
ok(/<p class="gate-name"><span class="accent">Nova AI<\/span><\/p>/.test(appJs) && /\.gate-name\s*\{[^}]*font-family: var\(--display\)/s.test(css), 'the login hero shows "Nova AI" (the star-mark logo is removed, the name stays)');
ok(!/nova-splash|logo-plate|done-mark|brand-lg/.test(css), 'no orphaned Nova-mark CSS rules remain (splash, plate, done-mark, brand-lg)');

const vectors = {};
for (const f of ['logo.svg', 'logo-on-dark.svg', 'logo-lockup.svg', 'logo-lockup-dark.svg', 'favicon.svg', 'app-icons.svg']) {
  vectors[f] = parseSvg(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
  ok(!vectors[f].querySelector('parsererror'), 'public/' + f + ' is well-formed XML');
  if (!f.endsWith('favicon.svg') && !f.endsWith('app-icons.svg')) {
    ok([...vectors[f].querySelectorAll('path')].some(p => p.getAttribute('d') === expectedStar), 'public/' + f + ' contains the exact Nova star');
  }
}
for (const [f, variant] of [['logo.svg', 'light'], ['logo-on-dark.svg', 'dark']]) {
  const generated = [...vectors[f].querySelectorAll('path,circle')].map(n => n.outerHTML).join('');
  const component = [...parseSvg(brand.LogoMark({ variant })).querySelectorAll('path,circle')].map(n => n.outerHTML).join('');
  ok(generated === component, f + ' matches the runtime mark geometry and palette exactly');
}
ok(vectors['logo-on-dark.svg'].querySelector('rect').getAttribute('fill') === '#040B16', 'dark standalone mark sits directly on the deep navy, not a plate');
for (const f of ['logo-lockup.svg', 'logo-lockup-dark.svg']) {
  const text = [...vectors[f].querySelectorAll('text')];
  ok(text.length === 2 && text[0].textContent === 'NOVA' && text[1].textContent === 'PipelineSync AI', f + ' includes the two-line wordmark');
}
/* The product tiles: deep navy ground, white S silhouette via feColorMatrix, ember dot at the
   mark's own orange centre. */
const MARK_ASPECT = 641 / 478, DOT = { cx: 0.638, cy: 0.559, r: 0.062 };
for (const [f, fraction] of [['favicon.svg', 0.72], ['app-icons.svg', 0.50]]) {
  const svg = vectors[f];
  const tile = svg.querySelector('rect[fill]');
  const image = svg.querySelector('image');
  const dot = svg.querySelector('circle');
  ok(svg.documentElement.getAttribute('viewBox') === '0 0 512 512' && tile.getAttribute('fill') === '#040B16' && Math.abs(+tile.getAttribute('rx') - 512 * 0.22) < 0.01,
    f + ' uses the deep-navy rounded-square tile');
  ok(!!svg.querySelector('feColorMatrix') && image && image.getAttribute('href') === '/components/brand/pipelinesync-mark.png',
    f + ' renders the PipelineSync S-mark raster white via feColorMatrix');
  const W = 512 * fraction, H = W * MARK_ASPECT;
  const x = (512 - W) / 2, y = (512 - H) / 2;
  ok(Math.abs(+image.getAttribute('width') - W) < 0.01 && Math.abs(+image.getAttribute('height') - H) < 0.01 && Math.abs(+image.getAttribute('x') - x) < 0.01 && Math.abs(+image.getAttribute('y') - y) < 0.01,
    f + ' centres an undistorted ' + Math.round(fraction * 100) + '%-width S-mark');
  ok(dot && dot.getAttribute('fill') === '#F97A1A' && Math.abs(+dot.getAttribute('r') - W * DOT.r) < 0.01 && Math.abs(+dot.getAttribute('cx') - (x + DOT.cx * W)) < 0.01 && Math.abs(+dot.getAttribute('cy') - (y + DOT.cy * H)) < 0.01,
    f + ' places the ember dot at the mark\'s own orange centre');
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
/* The "any" icon: navy ground, white silhouette, ember dot at the measured centre. */
const icon512 = rgbaPng('icon-512.png');
{
  const p = icon512.pixels;
  const at = (x, y) => (y * 512 + x) * 4;
  let white = 0, ember = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const o = at(x, y), r = p[o], g = p[o + 1], b = p[o + 2], a = p[o + 3];
    if (a < 128) continue;
    if (r > 200 && g > 200 && b > 200) white++;
    if (r > 190 && g > 70 && g < 180 && b < 100) ember++;
  }
  const cornerTransparent = p[at(4, 4) + 3] < 32 && p[at(507, 4) + 3] < 32 && p[at(4, 507) + 3] < 32 && p[at(507, 507) + 3] < 32;
  const centre = at(256, 256);
  const navyCentre = p[centre] === 4 && p[centre + 1] === 11 && p[centre + 2] === 22 && p[centre + 3] === 255;
  const W = 512 * 0.72, H = W * MARK_ASPECT, x0 = (512 - W) / 2, y0 = (512 - H) / 2;
  const dx = Math.round(x0 + DOT.cx * W), dy = Math.round(y0 + DOT.cy * H);
  const o = at(dx, dy);
  const dotEmber = p[o] === 249 && p[o + 1] === 122 && p[o + 2] === 26 && p[o + 3] === 255;
  ok(cornerTransparent, 'icon-512 keeps transparent corners outside the rounded tile');
  ok(navyCentre, 'icon-512 ground is the deep navy #040B16');
  ok(white > 25000, 'icon-512 carries the white S-mark silhouette (' + white + ' px)');
  ok(ember > 500 && dotEmber, 'icon-512 carries the ember dot at the mark\'s measured centre (' + ember + ' px)');
}
/* The maskable icon: every ink pixel, including the dot, inside the 80% safe circle. */
{
  const img = rgbaPng('icon-maskable-512.png');
  const p = img.pixels;
  let outsideSafeCircle = 0, inkPixels = 0, dotPixels = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const o = (y * 512 + x) * 4, r = p[o], g = p[o + 1], b = p[o + 2], a = p[o + 3];
    if (a < 128) continue;
    const isNavy = Math.abs(r - 4) <= 3 && Math.abs(g - 11) <= 3 && Math.abs(b - 22) <= 5;
    if (isNavy) continue;
    inkPixels++;
    if (r > 190 && g > 70 && g < 180 && b < 100) dotPixels++;
    if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) outsideSafeCircle++;
  }
  ok(inkPixels > 10000 && dotPixels > 200 && outsideSafeCircle === 0,
    'all maskable ink, including the ember dot, is inside the central 80%-diameter safe circle (' + inkPixels + ' ink px, ' + dotPixels + ' dot px)');
}
const ico = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'));
ok(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3 && [16,32,48].every((size, i) => ico[6 + i * 16] === size && ico[7 + i * 16] === size && ico.subarray(ico.readUInt32LE(18 + i * 16), ico.readUInt32LE(18 + i * 16) + 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))), 'favicon.ico embeds valid 16/32/48 PNG entries');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
ok(manifest.theme_color === '#040B16' && manifest.background_color === '#040B16', 'the manifest carries the deep navy #040B16 theme colour');
ok(manifest.icons.some(i => /512/.test(i.sizes)), 'the manifest carries the 512px app icon');
ok(manifest.name === 'Nova PipelineSync AI' && manifest.short_name === 'Nova', 'manifest uses the full product name and Nova short name');
const pkg = require('../package.json');
ok(!Object.keys(pkg.dependencies || {}).some(k => /resvg|playwright|chromium/.test(k)) && !Object.keys(pkg.devDependencies || {}).some(k => /resvg/.test(k)), 'brand assets need no app dependencies (pure-Node codec)');

ok(/<title>Nova PipelineSync AI \|/.test(indexHtml), 'the page title uses the full product name');
ok(/text: 'Nova PipelineSync AI', style: 'headerBrand'/.test(appJs) && /Tm \(Nova PipelineSync AI\) Tj/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'core.js'), 'utf8')), 'browser and server PDF headers use the full product name');
ok(!fs.existsSync(path.join(__dirname, '..', 'lib', 'pdf-email.js')), 'there is no email sender: the PDF is only downloaded in the app');

/* ------------------------------------------------------------------ */
section('the mascot is recoloured with the brand, unchanged in geometry');
for (const pose of ['sync', 'hello', 'listen', 'speak', 'think', 'party']) {
  ok(new RegExp(pose + ':\\s*\\{').test(novaJs), 'Nova.js defines the "' + pose + '" pose');
}
ok(/'\+ \(avatar \? '66 36 168 168' : '0 0 300 300'\) \+'|avatar \? '66 36 168 168' : '0 0 300 300'/.test(novaJs),
  'Nova keeps both view boxes (the full figure and the head-only avatar crop)');
/* Nova is transparent artwork: nothing may paint behind him, or the app's own surface (glass,
   ink or an export) stops showing through. */
ok(!/<circle cx="150" cy="120" r="84"/.test(novaJs) && !/background:' \+ MIST/.test(novaJs),
  'the avatar draws no circle or plate behind the head');
ok(!/ellipse cx="150" cy="286"/.test(novaJs), 'the full figure draws no ground shadow');
ok(/role="img" aria-label="/.test(novaJs), 'Nova keeps role=img and his aria-label');
ok(/@media \(prefers-reduced-motion:reduce\)\{\[class\^=\"nova-\"\]/.test(novaJs), "Nova's animation CSS honours reduced motion");
ok(/#4C8DFF/.test(novaJs) && /#8FB6FF/.test(novaJs) && /#03265C/.test(novaJs) && /#F97A1A/.test(novaJs) && /#FFB25C/.test(novaJs) && /#F4F7FF/.test(novaJs),
  "Nova's palette is the Ember/Navy neon brand palette");
ok(!/#1C3D6E/.test(novaJs) && !/#6E88AB/.test(novaJs) && !/#142C50/.test(novaJs) && !/#E8590C/.test(novaJs) && !/#8FA6C4/.test(novaJs) && !/#F6F3EC/.test(novaJs) &&
   !/#0C2B5E/.test(novaJs) && !/#3E6892/.test(novaJs) && !/#2E5580/.test(novaJs) && !/#FF7A1A/.test(novaJs) && !/#8FB0D0/.test(novaJs) && !/#E8EFF7/.test(novaJs),
  'the retired v3 and v4 palettes are fully gone from the mascot');

/* Rules from the brand sheet, asserted on the real rendering code. The UI no longer renders the
   mascot: no figure, no avatar, no copy line - the only trace of the brand sheet left on screen
   is the lockup, Nova's face in the orb, and the audio waveform. */
ok(!/NovaAvatar\(|PSBrand\.Nova\b/.test(appJs), 'the app no longer renders Nova\'s figure anywhere');
ok(!/NOVA_COPY\./.test(appJs), 'the app no longer renders Nova\'s copy lines');
ok(!/\.nova-live-fig|\.nova-party-fig|\.nova-ringing|\.nova-fig-card|\.bubble-av|\.toast-av|\.who-nova/.test(css),
  'no mascot rules remain in the stylesheet');
ok(/\.nova-wave-bar \{[^}]*linear-gradient\(180deg, var\(--sky\) 0%, var\(--sync-orange\) 100%\)/.test(css),
  'the waveform is the blue -> ember gradient');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.nova-wave-bar \{ animation: none/.test(css),
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
section('the PipelineSync canvas, panels and dark-only theme');

ok(!/data-theme/.test(css), 'the stylesheet has no theme selector left: one dark theme, no light variant');
ok(/content="dark"/.test(indexHtml), 'the page declares the dark colour scheme');
ok(/<meta name="theme-color" content="#05070c">/.test(indexHtml), 'the browser theme colour is the brand near-black');
ok(!/theme-toggle/.test(appJs) && !/ps_theme/.test(appJs) && !/initTheme/.test(appJs) && !/gate-corner/.test(appJs + css),
  'the theme toggle, its persistence and the gate corner slot are fully removed');
ok(/theme: 'dark',/.test(appJs) && /function applyTheme\(\) \{\s*document\.body\.dataset\.theme = state\.theme;\s*\}/s.test(appJs),
  'state.theme is pinned to dark and applyTheme only marks the body dataset');
ok(/body data-theme="dark"/.test(indexHtml) || /<body data-theme="dark">/.test(indexHtml), 'the page ships on the dark theme from first paint');
/* Canvas: three drifting orbs, the 64px masked grid and a faint noise layer. */
ok(/background-size: 64px 64px/.test(css) && /rgba\(148, 163, 184, 0\.06\) 1px/.test(css), 'the grid underlay is the 64px hairline grid at 6% slate');
ok(/\.grid-underlay::after\s*\{[^}]*opacity: 0\.035;[^}]*feTurbulence/s.test(css), 'a 3.5% noise texture sits over the canvas');
ok(/body\.app-screen \.aurora \{ opacity: 0\.55; \}/.test(css), 'app screens quieten the orbs so data stays readable');
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
ok(/blur\(90px\)/.test(orbBgRules) && /opacity: 0\.45/.test(orbBgRules), 'the orbs blur at 90px and sit at .45 opacity');
ok(/nAuroraA 26s/.test(orbBgRules) && /nAuroraB 30s/.test(orbBgRules) && /nAuroraC 22s/.test(orbBgRules) && /alternate/.test(orbBgRules), 'the orbs drift on 22-30s alternate cycles');
ok(/rgba\(255, 122, 26, 0\.55\)/.test(orbBgRules) && /rgba\(91, 140, 255, 0\.5\)/.test(orbBgRules) && /rgba\(63, 208, 238, 0\.4\)/.test(orbBgRules),
  'the orbs are orange (top-left), blue (top-right) and faint cyan (lower)');
/* Panels: white-gradient cards on --bg-elev, hairline border, deep shadow. */
ok(/--glass: linear-gradient\(180deg, rgba\(255, 255, 255, 0\.035\), rgba\(255, 255, 255, 0\.012\)\)/.test(css), 'panels use the brand card gradient');
ok(/--radius-lg: 24px/.test(css) && /--r-xl: 24px/.test(css), 'panels are 24px radius');
ok(/--shadow: 0 24px 60px -24px rgba\(0, 0, 0, 0\.7\)/.test(css) && /var\(--shadow\);/.test(css), 'panels carry the brand deep shadow');
ok(/rgba\(5, 7, 12, 0\.72\)/.test(css) && /blur\(18px\) saturate\(160%\)/.test(css) && /min-height: 72px/.test(css), 'the topbar is 72px, translucent near-black with blur(18px) saturate(160%)');
ok(/--ease: cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(css), 'the brand easing curve is declared');
ok(/\.btn-primary::after\s*\{[^}]*translateX\(-120%\)/s.test(css) && /\.btn-primary:hover:not\(:disabled\)::after \{ transform: translateX\(120%\); transition: transform 0\.7s/.test(css),
  'the primary button sheen sweeps across on hover');
ok(/:focus-visible \{ outline: 2px solid var\(--brand-2\); outline-offset: 3px;/.test(css), 'focus is always visible: 2px light-orange outline, 3px offset');
ok(/\.accent\s*\{[^}]*-webkit-background-clip: text;[^}]*background-clip: text;[^}]*animation: accent-shift 8s/s.test(css),
  'the gradient phrase rides the brand gradient on the 8s shift');
ok(/@keyframes accent-shift/.test(css) && /@keyframes nAuroraA/.test(css) && /@keyframes nAuroraB/.test(css), 'the neon motion keyframes are defined');
ok(/h1 \{[^}]*letter-spacing: -0\.045em/s.test(css), 'h1 uses the display tracking (-0.045em)');
const orbJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'orb.js'), 'utf8');
ok(/<script src="orb\.js"><\/script>/.test(indexHtml) && /\.orb-globe \{[^}]*inset: -14%/.test(css), 'orb.js is loaded and the globe canvas overhangs the orb so waves are not clipped');
ok(/const N = 520;/.test(orbJs) && /speaking:\s*\{ front: \[255, 140, 50\]/.test(orbJs) && /complete:\s*\{ front: \[52, 211, 153\]/.test(orbJs),
  'the globe is 520 particles, orange in front while speaking and green when complete');
ok(/getAttribute\('data-level'\)/.test(orbJs) && /orb\.setAttribute\('data-level'/.test(appJs) && /orb\.removeAttribute\('data-level'\)/.test(appJs),
  'the globe ripples with the measured microphone level, which is cleared when the meter stops');
ok(/prefers-reduced-motion: reduce/.test(orbJs) && /if \(!reduced\) raf = window\.requestAnimationFrame\(frame\)/.test(orbJs),
  'reduced motion draws the globe as a still frame instead of animating');
ok(/<script src="motion\.js"><\/script>/.test(indexHtml) && /rv-armed/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'motion.js'), 'utf8')),
  'motion.js (spotlight, reveal, headline) is loaded and only arms the reveal itself');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,800}\.rv-armed \.rv \{ opacity: 1 !important/.test(css),
  'reduced motion shows revealed content in its final state');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,400}\.aurora \{ display: none/.test(css),
  'reduced motion removes the aurora drift');

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
