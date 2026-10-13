/* Nova PipelineSync AI brand components. No runtime dependencies or build step.
 *
 * Identity split (PipelineSync "Ember/Navy elevated neon" theme):
 *   - PS lockup  = the PipelineSync S-mark (raster, components/brand/
 *     pipelinesync-mark.png) + the "Nova / PipelineSync AI" wordmark. This is
 *     the product identity: topbar, entry gate, icons, manifest.
 *   - NOVA_MARK  = Nova's own face (220x140 line/dot/star geometry, unchanged),
 *     used only where Nova herself appears: the voice orb, the loading splash,
 *     the done screen.
 * The generator (scripts/make-brand-assets.js) imports NOVA_MARK and the mark
 * geometry constants so static assets share them.
 */
(function (root) {
  'use strict';
  var NOVA_MARK = {
    viewBox: '0 0 220 140', width: 220, height: 140,
    star: 'M172 34 Q184 58 208 70 Q184 82 172 106 Q160 82 136 70 Q160 58 172 34 Z',
    lines: ['M14 30 L146 70', 'M6 70 L146 70', 'M14 110 L146 70'],
    dots: [[14, 30], [6, 70], [14, 110]]
  };
  // The PipelineSync S-mark raster is 478x641 (aspect 0.7457).
  var PS_MARK = { src: '/components/brand/pipelinesync-mark.png', width: 478, height: 641 };
  var LOGO_COLORS = {
    light: { line: '#0E1C36', dot: '#4C8DFF', star: '#F97A1A', text: '#0E1C36', sync: '#47546E' },
    dark: { line: '#4C8DFF', dot: '#8FB6FF', star: '#F97A1A', text: '#F4F7FF', sync: '#B7C3DE' }
  };
  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      if (c === '"') return '&quot;';
      return '&#39;';
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
  // The product lockup: PipelineSync S-mark + wordmark. The S-mark is white in
  // the browser via the .ps-mark-img CSS filter (brightness(0) invert(1) plus
  // the ember drop-shadow glow the site uses in its navbar). The raster keeps
  // its original colours in static exports, where the tile generator renders
  // it white at build time instead.
  function Logo(opts) {
    opts = opts || {};
    var variant = opts.variant === 'dark' ? 'dark' : 'light';
    var size = opts.size == null ? 32 : opts.size;
    var c = LOGO_COLORS[variant];
    var w = Math.round(size * PS_MARK.width / PS_MARK.height * 10) / 10;
    return '<span class="ps-lockup" role="img" aria-label="Nova PipelineSync AI">' +
      '<span class="ps-lockup-mark" aria-hidden="true">' +
        '<img class="ps-mark-img" src="' + PS_MARK.src + '" width="' + w + '" height="' + size + '" alt="">' +
      '</span>' +
      '<span class="ps-wordmark" aria-hidden="true" style="gap:' + (size * 0.12) + 'px">' +
        '<span class="ps-wordmark-name" style="color:' + c.text + ';font-size:' + (size * 0.55) + 'px">Nova</span>' +
        '<span class="ps-wordmark-sub" style="color:' + c.sync + ';font-size:' + (size * 0.27) + 'px">PipelineSync <span style="color:' + c.star + ';font-weight:700">AI</span></span>' +
      '</span></span>';
  }
  // The PipelineSync S-mark alone (no wordmark), for corner placements such as
  // the upper-left of the login screen. The .ps-mark-img filter renders it white
  // with the site navbar's ember glow, exactly as inside the lockup.
  function SMark(opts) {
    opts = opts || {};
    var size = opts.size == null ? 40 : opts.size;
    var w = Math.round(size * PS_MARK.width / PS_MARK.height * 10) / 10;
    return '<span class="ps-mark" role="img" aria-label="Nova PipelineSync AI">' +
      '<img class="ps-mark-img" src="' + PS_MARK.src + '" width="' + w + '" height="' + size + '" alt="">' +
      '</span>';
  }
  var BRAND = {
    navy: '#040B16', navy2: '#081226', navy3: '#0E1C36',
    steel: '#8FB6FF', steelDeep: '#03265C',
    syncOrange: '#F97A1A', syncOrangeSoft: '#FFB25C', syncOrangeHover: '#FF8F3D',
    sky: '#4C8DFF', mist: '#F4F7FF', muted: '#B7C3DE', faint: '#7C8AAB',
    ember: '#F97A1A', blue: '#4C8DFF', gold: '#FFC24B', green: '#2FD98A'
  };
  root.PSBrand = Object.assign(root.PSBrand || {}, {
    NOVA_MARK: NOVA_MARK, PS_MARK: PS_MARK, LOGO_COLORS: LOGO_COLORS, BRAND: BRAND,
    LogoMark: LogoMark, Logo: Logo, SMark: SMark
  });
})(typeof window !== 'undefined' ? window : this);
