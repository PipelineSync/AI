/* Static Nova assets. @resvg/resvg-js is a build-time-only tool, never an app
 * dependency. Install: npm i --no-save --package-lock=false @resvg/resvg-js
 * Or set RESVG_PATH to its package directory. Generated assets are committed.
 *
 * Nova Ink v4 geometry and palette (shared with the web component via the
 * PSBrand export in public/components/brand/Logo.js):
 *   - mark 220x140, three lines sw10, three dots r9, one 4-quadrant star
 *   - ember tile (favicon): #E8590C ground, paper mark, deep-navy star
 *   - navy tile (app):      #1C3D6E ground, paper lines, sky dots, ember star
 */
const fs = require('fs');
const path = require('path');
const PUBLIC = path.join(__dirname, '..', 'public');
const { NOVA_MARK: mark, LogoMark, LOGO_COLORS } = require('../public/components/brand/Logo.js').PSBrand;

const TILE = {
  ember: { ground: '#E8590C', line: '#F6F3EC', dot: '#F6F3EC', star: '#17335C' },
  navy: { ground: '#1C3D6E', line: '#F6F3EC', dot: '#8FA6C4', star: '#F76B15' }
};

function iconMark(kind) {
  const c = TILE[kind];
  return mark.lines.map(d => `<path d="${d}" fill="none" stroke="${c.line}" stroke-width="14" stroke-linecap="round"/>`).join('') +
    mark.dots.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="12" fill="${c.dot}"/>`).join('') +
    `<path d="${mark.star}" fill="${c.star}"/>`;
}
function tile(size, kind = 'navy', fraction = 0.72) {
  const c = TILE[kind];
  const scale = size * fraction / mark.width;
  const x = (size - mark.width * scale) / 2;
  const y = (size - mark.height * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Nova PipelineSync AI">` +
    `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${c.ground}"/>` +
    `<g transform="translate(${x} ${y}) scale(${scale})">${iconMark(kind)}</g></svg>\n`;
}
function standalone(variant) {
  let svg = LogoMark({ variant, size: 140 });
  if (variant === 'dark') svg = svg.replace(/(<svg[^>]*>)/, '$1<rect x="-10" y="-8" width="240" height="156" fill="#14161B" rx="12"/>');
  return svg + '\n';
}
function lockup(variant) {
  const c = LOGO_COLORS[variant];
  const bg = variant === 'dark' ? '<rect width="620" height="170" fill="#14161B"/>' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 170" width="620" height="170" role="img" aria-label="Nova PipelineSync AI">' + bg +
    '<g transform="translate(16 15)">' + LogoMark({ variant, size: 140 }) + '</g>' +
    `<g font-family="Arial, Helvetica, sans-serif"><text x="272" y="88" fill="${c.text}" font-size="84" font-weight="700" letter-spacing="0.14em">NOVA</text>` +
    `<text x="274" y="142" fill="${c.sync}" font-size="39" font-weight="600">PipelineSync <tspan fill="${c.star}" font-weight="700">AI</tspan></text></g></svg>\n`;
}

function write(name, text) {
  fs.writeFileSync(path.join(PUBLIC, name), text);
  console.log('  wrote public/' + name + ' (' + Buffer.byteLength(text) + ' bytes)');
}

function loadResvg() {
  const candidates = [process.env.RESVG_PATH, '@resvg/resvg-js'].filter(Boolean);
  for (const c of candidates) {
    // An explicit path may point at the package directory rather than at its entry file.
    try { return require(c); } catch (e) {}
    try { return require(require('path').join(c, 'index.js')); } catch (e) {}
  }
  return null;
}

function png(svg, width) {
  const { Resvg } = loadResvg();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  return r.render().asPng();
}

/* A multi-size .ico: PNG payloads are valid ICO entries (the format allows PNG or BMP data). */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

// Fail before writing anything if rasterisation is unavailable: never silently
// leave old PNG/ICO artwork alongside newly generated vectors.
if (!loadResvg()) throw new Error('Install build-time @resvg/resvg-js or set RESVG_PATH before running brand:icons.');
console.log('Nova PipelineSync AI brand assets');
write('logo.svg', standalone('light'));
write('logo-on-dark.svg', standalone('dark'));
write('logo-lockup.svg', lockup('light'));
write('logo-lockup-dark.svg', lockup('dark'));
write('favicon.svg', tile(512, 'ember'));
write('app-icons.svg', tile(512, 'navy'));
write('icon-512.png', png(tile(512, 'navy'), 512));
// 60% width puts the ENTIRE mark in the central 80%-diameter circle, not
// merely its central square. The tile background intentionally reaches edges.
write('icon-maskable-512.png', png(tile(512, 'navy', 0.60), 512));
write('apple-touch-icon.png', png(tile(180, 'navy'), 180));
write('favicon.ico', ico([16, 32, 48].map(size => ({ size, png: png(tile(size, 'ember'), size) }))));
