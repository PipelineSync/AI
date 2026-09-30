/* Nova brand components. No runtime dependencies or build step.
 * size is the mark's height; its 222:162 aspect ratio is never stretched.
 * The generator imports NOVA_MARK so component and static assets share geometry.
 */
(function (root) {
  'use strict';
  var NOVA_MARK = {
    viewBox: '-10 16 222 162', width: 222, height: 162,
    star: 'M138 28 Q146 92 206 100 Q146 108 138 172 Q130 108 70 100 Q130 92 138 28 Z',
    spark: 'M186 22 Q188 38 204 40 Q188 42 186 58 Q184 42 168 40 Q184 38 186 22 Z',
    lines: ['M16 50 C50 50 56 100 84 100', 'M6 100 L84 100', 'M16 150 C50 150 56 100 84 100'],
    dots: [[16, 50], [6, 100], [16, 150]]
  };
  var LOGO_COLORS = {
    light: { line: '#0C2B5E', dot: '#3E6892', star: '#FF7A1A', spark: '#3E6892', text: '#0C2B5E', sync: '#3E6892' },
    dark: { line: '#E8EFF7', dot: '#8FB0D0', star: '#FF7A1A', spark: '#8FB0D0', text: '#FFFFFF', sync: '#8FB0D0' }
  };
  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // CSS motion paths use the exact line geometry. Reduced motion restores the
  // dots to their original centres and leaves the star completely stationary.
  var ANIMATED_CSS = '.ps-flow-dot{offset-rotate:0deg;animation:ps-flow 2.8s ease-in-out infinite}\n' +
    '.ps-pulse-star{transform-box:fill-box;transform-origin:center;animation:ps-pulse 2.8s ease-in-out infinite}\n' +
    '@keyframes ps-flow{0%,10%{offset-distance:0%;opacity:1}55%{offset-distance:100%;opacity:1}65%,100%{offset-distance:100%;opacity:0}}\n' +
    '@keyframes ps-pulse{0%,60%,100%{transform:scale(1)}76%{transform:scale(1.035)}}\n' +
    '@media (prefers-reduced-motion:reduce){.ps-flow-dot{animation:none;offset-path:none!important;opacity:1}.ps-pulse-star{animation:none;transform:none}}';

  function LogoMark(opts) {
    opts = opts || {};
    var variant = opts.variant === 'dark' ? 'dark' : 'light';
    var size = opts.size == null ? 40 : opts.size;
    var c = LOGO_COLORS[variant];
    var animated = !!opts.animated;
    var cls = opts.className ? ' class="' + escAttr(opts.className) + '"' : '';
    var h = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + NOVA_MARK.viewBox + '" height="' + size + '" width="' + (size * 222 / 162) + '" role="img" aria-label="Nova PipelineSync AI"' + cls + '>';
    if (animated) h += '<style>' + ANIMATED_CSS + '</style>';
    NOVA_MARK.lines.forEach(function (d) {
      h += '<path d="' + d + '" fill="none" stroke="' + c.line + '" stroke-width="14" stroke-linecap="round"/>';
    });
    NOVA_MARK.dots.forEach(function (p, i) {
      // offset-anchor at the circle centre keeps each moving dot on its line.
      h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="12" fill="' + c.dot + '"' +
        (animated ? ' class="ps-flow-dot" style="offset-path:path(\'' + NOVA_MARK.lines[i] + '\');offset-anchor:' + p[0] + 'px ' + p[1] + 'px"' : '') + '/>';
    });
    h += '<path d="' + NOVA_MARK.star + '" fill="' + c.star + '"' + (animated ? ' class="ps-pulse-star"' : '') + '/>';
    h += '<path d="' + NOVA_MARK.spark + '" fill="' + c.spark + '"/>';
    return h + '</svg>';
  }
  function Logo(opts) {
    opts = opts || {};
    var variant = opts.variant === 'dark' ? 'dark' : 'light';
    var size = opts.size == null ? 32 : opts.size;
    var c = LOGO_COLORS[variant];
    return '<span class="ps-lockup" role="img" aria-label="Nova PipelineSync AI">' +
      '<span class="ps-lockup-mark" aria-hidden="true">' + LogoMark({ variant: variant, size: size }) + '</span>' +
      '<span class="ps-wordmark" aria-hidden="true" style="gap:' + (size * 0.12) + 'px">' +
        '<span class="ps-wordmark-name" style="color:' + c.text + ';font-size:' + (size * 0.6) + 'px">NOVA</span>' +
        '<span class="ps-wordmark-sub" style="color:' + c.sync + ';font-size:' + (size * 0.28) + 'px">PipelineSync <span style="color:#FF7A1A;font-weight:800">AI</span></span>' +
      '</span></span>';
  }
  var BRAND = {
    navy: '#0C2B5E', steel: '#3E6892', steelDeep: '#2E5580',
    syncOrange: '#FF7A1A', syncOrangeHover: '#E8660A', sky: '#8FB0D0', mist: '#E8EFF7', void: '#0A0E17'
  };
  root.PSBrand = Object.assign(root.PSBrand || {}, {
    NOVA_MARK: NOVA_MARK, LOGO_COLORS: LOGO_COLORS, BRAND: BRAND, LogoMark: LogoMark, Logo: Logo
  });
})(typeof window !== 'undefined' ? window : this);
