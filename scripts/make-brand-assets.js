/*
 * Brand asset generator: builds public/favicon.svg, public/app-icons.svg (the 512px PWA icon),
 * public/icon-512.png, public/apple-touch-icon.png (180x180) and public/favicon.ico (48/32/16)
 * from the LogoMark geometry in public/components/brand/Logo.js.
 *
 * Every tile is the static light mark on a navy #0C2B5E rounded square, as the brand sheet asks.
 * PNG rendering uses @resvg/resvg-js, which is a build-time-only tool: it is NOT a dependency of
 * the app (package.json still declares zero runtime dependencies) and it is never fetched at
 * runtime. Run it with:
 *
 *   npm i --no-save @resvg/resvg-js && npm run brand:icons
 *   RESVG_PATH=/path/to/@resvg/resvg-js node scripts/make-brand-assets.js
 *
 * The generated files are committed, so a normal checkout never needs to run this.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

/* The mark, drawn from the same geometry as components/brand/Logo.js (light variant), centred on a
   navy rounded-square tile. S = tile size, M = the mark's height inside it. */
function tile(S, pad) {
  const M = S - pad * 2;
  const W = (M * 440) / 590;                 // the mark's own aspect ratio: never stretched
  const x = (S - W) / 2, y = pad;
  const k = M / 590;                         // viewBox "20 20 440 590" -> page units
  const X = v => x + (v - 20) * k;
  const Y = v => y + (v - 20) * k;
  const sw = 55 * k, r = 10 * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="PipelineSync AI">` +
    `<rect width="${S}" height="${S}" rx="${(S * 0.22).toFixed(2)}" fill="#0C2B5E"/>` +
    // The two S strokes, drawn in tile coordinates.
    `<path d="M${X(416)} ${Y(57.5)} V${Y(162)} H${X(160)} A${(97.5 * k).toFixed(2)} ${(97.5 * k).toFixed(2)} 0 0 0 ${X(160)} ${Y(357)} H${X(212)}" ` +
      `fill="none" stroke="#FFFFFF" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>` +
    `<rect x="${X(388.5)}" y="${Y(30)}" width="${(55 * k).toFixed(2)}" height="${(40 * k).toFixed(2)}" fill="#FFFFFF"/>` +
    `<path d="M${X(172)} ${Y(260)} H${X(320)} A${(98.5 * k).toFixed(2)} ${(98.5 * k).toFixed(2)} 0 0 1 ${X(320)} ${Y(457)} H${X(62)} V${Y(572.5)}" ` +
      `fill="none" stroke="#8FB0D0" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>` +
    `<rect x="${X(34.5)}" y="${Y(560)}" width="${(55 * k).toFixed(2)}" height="${(40 * k).toFixed(2)}" fill="#8FB0D0"/>` +
    `<rect x="${X(278)}" y="${Y(330)}" width="${(54 * k).toFixed(2)}" height="${(54 * k).toFixed(2)}" rx="${r.toFixed(2)}" fill="#FF7A1A"/>` +
    `</svg>\n`;
}

/* The inline <svg> the browser/OS render as a document icon. No rounded tile here: the SVG is the
   file icon, so it keeps a transparent background and the light mark is legible on either theme. */
function glyph() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 20 440 590" width="440" height="590" role="img" aria-label="PipelineSync AI">` +
    `<rect x="20" y="20" width="440" height="590" rx="96" fill="#0C2B5E"/>` +
    `<path d="M416 57.5 V162 H160 A97.5 97.5 0 0 0 160 357 H212" fill="none" stroke="#FFFFFF" stroke-width="55" stroke-linecap="round"/>` +
    `<rect x="388.5" y="30" width="55" height="40" fill="#FFFFFF"/>` +
    `<path d="M172 260 H320 A98.5 98.5 0 0 1 320 457 H62 V572.5" fill="none" stroke="#8FB0D0" stroke-width="55" stroke-linecap="round"/>` +
    `<rect x="34.5" y="560" width="55" height="40" fill="#8FB0D0"/>` +
    `<rect x="278" y="330" width="54" height="54" rx="10" fill="#FF7A1A"/>` +
    `</svg>\n`;
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

console.log('PipelineSync AI brand assets');
write('favicon.svg', glyph());
write('app-icons.svg', tile(512, 76));

const resvg = loadResvg();
if (!resvg) {
  console.log('  (@resvg/resvg-js not installed: PNG sizes skipped. The committed PNGs are unchanged.)');
  console.log('  install with: npm i --no-save @resvg/resvg-js');
} else {
  fs.writeFileSync(path.join(PUBLIC, 'icon-512.png'), png(tile(512, 76), 512));
  console.log('  wrote public/icon-512.png');
  fs.writeFileSync(path.join(PUBLIC, 'icon-maskable-512.png'), png(tile(512, 120), 512));
  console.log('  wrote public/icon-maskable-512.png');
  fs.writeFileSync(path.join(PUBLIC, 'apple-touch-icon.png'), png(tile(180, 26), 180));
  console.log('  wrote public/apple-touch-icon.png (180x180)');
  fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'),
    ico([{ size: 48, png: png(tile(48, 7), 48) }, { size: 32, png: png(tile(32, 5), 32) }, { size: 16, png: png(tile(16, 2), 16) }]));
  console.log('  wrote public/favicon.ico (48/32/16)');
}
