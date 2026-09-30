/* Static Nova assets. @resvg/resvg-js is a build-time-only tool, never an app
 * dependency. Install: npm i --no-save --package-lock=false @resvg/resvg-js
 * Or set RESVG_PATH to its package directory. Generated assets are committed.
 */
const fs = require('fs');
const path = require('path');
const PUBLIC = path.join(__dirname, '..', 'public');
const { NOVA_MARK: mark, LogoMark, LOGO_COLORS } = require('../public/components/brand/Logo.js').PSBrand;

function iconMark(tileColor) {
  const orange = tileColor === '#FF7A1A';
  const dot = orange ? '#FFFFFF' : '#8FB0D0';
  const star = orange ? '#0C2B5E' : '#FF7A1A';
  return mark.lines.map(d => `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/>`).join('') +
    mark.dots.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="13" fill="${dot}"/>`).join('') +
    `<path d="${mark.star}" fill="${star}"/>`;
}
function tile(size, color = '#0C2B5E', fraction = 0.72) {
  const scale = size * fraction / mark.width;
  const x = (size - mark.width * scale) / 2;
  const y = (size - mark.height * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Nova PipelineSync AI">` +
    `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${color}"/>` +
    `<g transform="translate(${x} ${y}) scale(${scale}) translate(10 -16)">${iconMark(color)}</g></svg>\n`;
}
function standalone(variant) {
  let svg = LogoMark({ variant, size: 162 });
  if (variant === 'dark') svg = svg.replace(/(<svg[^>]*>)/, '$1<rect x="-10" y="16" width="222" height="162" fill="#0A0E17"/>');
  return svg + '\n';
}
function lockup(variant) {
  const c = LOGO_COLORS[variant];
  const bg = variant === 'dark' ? '<rect width="690" height="194" fill="#0A0E17"/>' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 690 194" width="690" height="194" role="img" aria-label="Nova PipelineSync AI">' + bg +
    '<g transform="translate(16 16)">' + LogoMark({ variant, size: 162 }) + '</g>' +
    `<g font-family="Arial, Helvetica, sans-serif"><text x="266" y="100" fill="${c.text}" font-size="97.2" font-weight="800" letter-spacing="0.09em">NOVA</text>` +
    `<text x="268" y="175" fill="${c.sync}" font-size="45.36" font-weight="600">PipelineSync <tspan fill="#FF7A1A" font-weight="800">AI</tspan></text></g></svg>\n`;
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
write('favicon.svg', tile(512, '#FF7A1A'));
write('app-icons.svg', tile(512));
write('icon-512.png', png(tile(512), 512));
// 60% width puts the ENTIRE mark in the central 80%-diameter circle, not
// merely its central square. The tile background intentionally reaches edges.
write('icon-maskable-512.png', png(tile(512, '#0C2B5E', 0.60), 512));
write('apple-touch-icon.png', png(tile(180), 180));
write('favicon.ico', ico([16, 32, 48].map(size => ({ size, png: png(tile(size, '#FF7A1A'), size) }))));
