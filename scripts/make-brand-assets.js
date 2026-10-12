/* Static Nova PipelineSync AI brand assets (Ember/Navy neon, v5).
 *
 * Zero dependencies: the S-mark is decoded from the PipelineSync website's
 * 4-bit palette PNG with a hand-rolled codec, and every raster is encoded
 * with a hand-rolled PNG writer (zlib only). No build-time renderer is
 * needed, so this script runs anywhere `node` runs.
 *
 * Identity: the product icons are the PipelineSync S-mark — white silhouette
 * on the deep-navy #040B16 tile with the ember #F97A1A dot (the dot is drawn
 * at the mark's own orange-centre, measured from the source PNG). Nova's own
 * mark (220x140, from public/components/brand/Logo.js) is exported for the
 * Nova-moment screens only.
 *
 * Generated assets are committed.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PUBLIC = path.join(__dirname, '..', 'public');
const { NOVA_MARK: mark, LogoMark, LOGO_COLORS } = require('../public/components/brand/Logo.js').PSBrand;

/* ------------------------------------------------------------------ */
/* PNG: decode the site's S-mark (colour type 3, bit depth 4, tRNS)    */
/* ------------------------------------------------------------------ */
function decodeMarkPng(file) {
  const b = fs.readFileSync(file);
  // The site's mark is a 4-bit palette PNG (16 colours + tRNS alpha).
  if (b.readUInt8(24) !== 4 || b.readUInt8(25) !== 3) throw new Error('S-mark PNG must be a 4-bit palette');
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  let plte = null, trns = null;
  const idat = [];
  for (let at = 8; at < b.length;) {
    const size = b.readUInt32BE(at);
    const type = b.toString('ascii', at + 4, at + 8);
    const data = b.subarray(at + 8, at + 8 + size);
    if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    at += 12 + size;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rawStride = Math.ceil(width * 4 / 8);
  const bytes = Buffer.alloc(height * rawStride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rawStride + 1)];
    const start = y * (rawStride + 1) + 1;
    for (let i = 0; i < rawStride; i++) {
      const a = i >= 1 ? bytes[y * rawStride + i - 1] : 0;
      const up = y ? bytes[(y - 1) * rawStride + i] : 0;
      const ul = y && i >= 1 ? bytes[(y - 1) * rawStride + i - 1] : 0;
      const pred = a + up - ul;
      const da = Math.abs(pred - a), db = Math.abs(pred - up), dc = Math.abs(pred - ul);
      const paeth = da <= db && da <= dc ? a : db <= dc ? up : ul;
      bytes[y * rawStride + i] = (raw[start + i] + [0, a, up, Math.floor((a + up) / 2), paeth][filter]) & 0xFF;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rb = bytes[y * rawStride + (x / 2) | 0];
      const idx = x % 2 === 0 ? rb >> 4 : rb & 0xF;
      const o = (y * width + x) * 4;
      rgba[o] = plte[idx * 3]; rgba[o + 1] = plte[idx * 3 + 1]; rgba[o + 2] = plte[idx * 3 + 2];
      rgba[o + 3] = trns ? (trns[idx] != null ? trns[idx] : 255) : 255;
    }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* PNG: encode RGBA8                                                  */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // RGBA8
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ */
/* Compositing: navy rounded tile + white S-mark + ember dot          */
/* ------------------------------------------------------------------ */
const NAVY = [4, 11, 22];        // #040B16
const WHITE = [255, 255, 255];
const EMBER = [249, 122, 26];    // #F97A1A

// The S-mark's orange dot, measured from the source PNG (478x641 canvas):
// centre at (0.638, 0.559) of the mark, solid core ~11.3% of the mark width.
const DOT = { cx: 0.638, cy: 0.559, r: 0.062 };

function coverage(size, radius, x, y) {
  // Rounded-rect SDF coverage with 1px anti-aliasing.
  const ax = x - size / 2, ay = y - size / 2;
  const qx = Math.abs(ax) - (size / 2 - radius), qy = Math.abs(ay) - (size / 2 - radius);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return Math.max(0, Math.min(1, 0.5 - d));
}
function sampleMark(rgba, w, h, u, v) {
  // Bilinear sample of the white mark (u,v in 0..1) -> [r,g,b,a].
  const x = Math.max(0, Math.min(w - 1.001, u * w - 0.5));
  const y = Math.max(0, Math.min(h - 1.001, v * h - 0.5));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = rgba[i00 + c] + (rgba[i10 + c] - rgba[i00 + c]) * fx;
    const bot = rgba[i01 + c] + (rgba[i11 + c] - rgba[i01 + c]) * fx;
    out[c] = top + (bot - top) * fy;
  }
  return out;
}
function composeTile(size, fraction) {
  const mark = MARK;
  const W = size * fraction, H = W * mark.height / mark.width;
  const x0 = (size - W) / 2, y0 = (size - H) / 2;
  const radius = size * 0.22;
  const dotR = W * DOT.r;
  const dotX = x0 + DOT.cx * W, dotY = y0 + DOT.cy * H;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = coverage(size, radius, x + 0.5, y + 0.5);
      let r = NAVY[0], g = NAVY[1], b = NAVY[2];
      // White S-mark over the navy ground.
      if (cov > 0) {
        const m = sampleMark(mark.rgba, mark.width, mark.height, (x - x0) / W, (y - y0) / H);
        const a = Math.max(0, Math.min(1, m[3] / 255));
        r += (WHITE[0] - r) * a; g += (WHITE[1] - g) * a; b += (WHITE[2] - b) * a;
        // Ember dot over the silhouette (the site's dot colour, #F97610 ~ #F97A1A).
        const d = Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY) - dotR;
        const da = Math.max(0, Math.min(1, 0.5 - d));
        if (da > 0) { r += (EMBER[0] - r) * da; g += (EMBER[1] - g) * da; b += (EMBER[2] - b) * da; }
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r); rgba[o + 1] = Math.round(g); rgba[o + 2] = Math.round(b);
      rgba[o + 3] = Math.round(255 * cov);
    }
  }
  return rgba;
}

const MARK = decodeMarkPng(path.join(__dirname, '..', 'public', 'components', 'brand', 'pipelinesync-mark.png'));
// Sanity: the decode must actually see the orange dot (palette index 8 = #F97610).
const dotCount = (() => { let n = 0; for (let i = 0; i < MARK.rgba.length; i += 4) if (MARK.rgba[i] > 190 && MARK.rgba[i + 2] < 90 && MARK.rgba[i + 3] > 200) n++; return n; })();
if (dotCount < 200) throw new Error('S-mark decode sanity failed (orange dot pixels: ' + dotCount + ')');
console.log('S-mark decoded: ' + MARK.width + 'x' + MARK.height + ' (' + dotCount + ' orange core pixels)');

/* ------------------------------------------------------------------ */
/* Vector assets (Nova mark geometry from Logo.js)                    */
/* ------------------------------------------------------------------ */
function standalone(variant) {
  let svg = LogoMark({ variant, size: 140 });
  if (variant === 'dark') svg = svg.replace(/(<svg[^>]*>)/, '$1<rect x="-10" y="-8" width="240" height="156" fill="#040B16" rx="12"/>');
  return svg + '\n';
}
function lockup(variant) {
  const c = LOGO_COLORS[variant];
  const bg = variant === 'dark' ? '<rect width="620" height="170" fill="#040B16"/>' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 170" width="620" height="170" role="img" aria-label="Nova PipelineSync AI">' + bg +
    '<g transform="translate(16 15)">' + LogoMark({ variant, size: 140 }) + '</g>' +
    `<g font-family="Arial, Helvetica, sans-serif"><text x="272" y="88" fill="${c.text}" font-size="84" font-weight="700" letter-spacing="0.14em">NOVA</text>` +
    `<text x="274" y="142" fill="${c.sync}" font-size="39" font-weight="600">PipelineSync <tspan fill="${c.star}" font-weight="700">AI</tspan></text></g></svg>\n`;
}
// The S-mark product tile as vector art: navy ground, white silhouette via
// feColorMatrix, ember dot. Browsers render this; the committed PNGs are the
// pure-Node rasters of the same composition.
function sTile(size, fraction) {
  const W = size * fraction, H = W * MARK.height / MARK.width;
  const x = (size - W) / 2, y = (size - H) / 2;
  const r = size * 0.22;
  const dotR = W * DOT.r;
  const dotX = x + DOT.cx * W, dotY = y + DOT.cy * H;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Nova PipelineSync AI">` +
    `<defs><clipPath id="t"><rect width="${size}" height="${size}" rx="${r}"/></clipPath>` +
    `<filter id="wm" x="-2%" y="-2%" width="104%" height="104%"><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter></defs>` +
    `<g clip-path="url(#t)">` +
    `<rect width="${size}" height="${size}" rx="${r}" fill="#040B16"/>` +
    `<image href="/components/brand/pipelinesync-mark.png" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${W.toFixed(2)}" height="${H.toFixed(2)}" preserveAspectRatio="none" filter="url(#wm)"/>` +
    `<circle cx="${dotX.toFixed(2)}" cy="${dotY.toFixed(2)}" r="${dotR.toFixed(2)}" fill="#F97A1A"/>` +
    `</g></svg>\n`;
}

/* ------------------------------------------------------------------ */
/* Multi-size .ico: PNG payloads are valid ICO entries.               */
/* ------------------------------------------------------------------ */
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

function write(name, buf) {
  fs.writeFileSync(path.join(PUBLIC, name), buf);
  console.log('  wrote public/' + name + ' (' + buf.length + ' bytes)');
}

console.log('Nova PipelineSync AI brand assets (Ember/Navy neon)');
write('logo.svg', Buffer.from(standalone('light')));
write('logo-on-dark.svg', Buffer.from(standalone('dark')));
write('logo-lockup.svg', Buffer.from(lockup('light')));
write('logo-lockup-dark.svg', Buffer.from(lockup('dark')));
write('favicon.svg', Buffer.from(sTile(512, 0.72)));
write('app-icons.svg', Buffer.from(sTile(512, 0.50)));
write('icon-512.png', encodePng(512, 512, composeTile(512, 0.72)));
// The S-mark is a tall 478:641 mark whose ink reaches near the canvas corners,
// so the maskable version runs at 50% width: the ENTIRE ink, including the top
// hook and bottom sweep, stays inside the central 80%-diameter safe circle
// (checked in test/ui-design.js). The tile background intentionally reaches
// the edges either way.
write('icon-maskable-512.png', encodePng(512, 512, composeTile(512, 0.50)));
write('apple-touch-icon.png', encodePng(180, 180, composeTile(180, 0.72)));
write('favicon.ico', ico([16, 32, 48].map(size => ({ size, png: encodePng(size, size, composeTile(size, 0.72)) }))));
console.log('done');
