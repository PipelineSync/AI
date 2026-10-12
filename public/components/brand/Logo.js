/* Nova brand components. No runtime dependencies or build step.
 * size is the mark's height; its 220:140 aspect ratio is never stretched.
 * The generator imports NOVA_MARK so component and static assets share geometry.
 */
(function (root) {
  'use strict';
  var NOVA_MARK = {
    viewBox: '0 0 220 140', width: 220, height: 140,
    star: 'M172 34 Q184 58 208 70 Q184 82 172 106 Q160 82 136 70 Q160 58 172 34 Z',
    lines: ['M14 30 L146 70', 'M6 70 L146 70', 'M14 110 L146 70'],
    dots: [[14, 30], [6, 70], [14, 110]]
  };
  var LOGO_COLORS = {
    light: { line: '#1B1E24', dot: '#6E88AB', star: '#E8590C', text: '#1B1E24', sync: '#4A5262' },
    dark: { line: '#EDEAE1', dot: '#8FA6C4', star: '#F76B15', text: '#EDEAE1', sync: '#A9B4C6' }
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
    var h = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + NOVA_MARK.viewBox + '" height="' + size + '" width="' + (size * 220 / 140) + '" role="img" aria-label="Nova PipelineSync AI"' + cls + '>';
    if (animated) h += '<style>' + ANIMATED_CSS + '</style>';
    NOVA_MARK.lines.forEach(function (d) {
      h += '<path d="' + d + '" fill="none" stroke="' + c.line + '" stroke-width="10" stroke-linecap="round"/>';
    });
    NOVA_MARK.dots.forEach(function (p, i) {
      // offset-anchor at the circle centre keeps each moving dot on its line.
      h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="9" fill="' + c.dot + '"' +
        (animated ? ' class="ps-flow-dot" style="offset-path:path(\'' + NOVA_MARK.lines[i] + '\');offset-anchor:' + p[0] + 'px ' + p[1] + 'px"' : '') + '/>';
    });
    h += '<path d="' + NOVA_MARK.star + '" fill="' + c.star + '"' + (animated ? ' class="ps-pulse-star"' : '') + '/>';
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
        '<span class="ps-wordmark-name" style="color:' + c.text + ';font-size:' + (size * 0.55) + 'px">NOVA</span>' +
        '<span class="ps-wordmark-sub" style="color:' + c.sync + ';font-size:' + (size * 0.27) + 'px">PipelineSync <span style="color:' + c.star + ';font-weight:700">AI</span></span>' +
      '</span></span>';
  }
  var BRAND = {
    navy: '#1C3D6E', steel: '#6E88AB', steelDeep: '#142C50',
    syncOrange: '#E8590C', syncOrangeDark: '#F76B15', syncOrangeHover: '#C74A08', sky: '#8FA6C4', mist: '#F6F3EC', ink: '#1B1E24', paper: '#F6F3EC', void: '#14161B'
  };
  root.PSBrand = Object.assign(root.PSBrand || {}, {
    NOVA_MARK: NOVA_MARK, LOGO_COLORS: LOGO_COLORS, BRAND: BRAND, LogoMark: LogoMark, Logo: Logo
  });
})(typeof window !== 'undefined' ? window : this);
