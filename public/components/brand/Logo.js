/*
 * PipelineSync AI brand logo — components/brand/Logo.
 * ---------------------------------------------------------------------------
 * This is the PipelineSync AI React component (`components/brand/Logo.tsx`) ported to the
 * technology this app actually ships: the prototype frontend is plain HTML/CSS/JS with no build
 * step (see README, "no build step needed"), so the same two components are expressed as string
 * builders that the app injects with the rest of its markup.
 *
 * The SVG geometry, colours, viewBox, stroke widths, the animated flowing dots and the inline
 * <style> block are copied from the React source character for character. Nothing was redrawn,
 * simplified or recoloured. The only differences are the mechanics of the port:
 *   - JSX attributes become attributes (strokeWidth -> stroke-width, className -> class),
 *   - React.useId() becomes a module counter, so the two animated motion paths keep unique ids,
 *   - the components return an HTML string instead of a React element.
 *
 * Usage (all options optional):
 *   PSBrand.LogoMark({ variant: "light"|"dark", size: 40, animated: false, className: "" })
 *   PSBrand.Logo({ variant: "light"|"dark", size: 32 })
 *
 * Rules from the brand sheet: never recolour, never stretch (the mark is drawn at its own aspect
 * ratio), and on a dark surface use variant "dark" (or sit the light variant on a light plate).
 */
(function (root) {
  'use strict';

  var LOGO_COLORS = {
    light: { top: '#0C2B5E', bot: '#3E6892', text: '#0C2B5E', sync: '#3E6892' },
    dark: { top: '#FFFFFF', bot: '#6F9BCB', text: '#FFFFFF', sync: '#8FB7E0' }
  };

  /* Markup the children of an element must never be able to change. */
  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* `animated` adds flowing dots for loading screens (use on light backgrounds). */
  var ANIMATED_CSS = '.ps-dot{transform-box:fill-box;transform-origin:center;animation:ps-dot 1.6s ease-in-out infinite}\n' +
    '        @keyframes ps-dot{50%{transform:scale(1.2) rotate(8deg)}}\n' +
    '        @media (prefers-reduced-motion:reduce){.ps-dot{animation:none}}';

  var uid = 0;

  /** The S mark. */
  function LogoMark(opts) {
    opts = opts || {};
    var variant = opts.variant === 'dark' ? 'dark' : 'light';
    var size = opts.size == null ? 40 : opts.size;
    var animated = !!opts.animated;
    var c = LOGO_COLORS[variant];
    var id = 'ps' + (++uid);
    var cls = opts.className ? ' class="' + escAttr(opts.className) + '"' : '';
    var h = '<svg viewBox="20 20 440 590" height="' + size + '" width="' + (size * 440 / 590) + '"' +
      ' role="img" aria-label="PipelineSync AI"' + cls + '>';
    if (animated) h += '<style>' + ANIMATED_CSS + '</style>';
    h += '<path d="M416 57.5 V162 H160 A97.5 97.5 0 0 0 160 357 H212" fill="none" stroke="' + c.top + '" stroke-width="55" stroke-linecap="round" />';
    h += '<rect x="388.5" y="30" width="55" height="40" fill="' + c.top + '" />';
    h += '<path d="M172 260 H320 A98.5 98.5 0 0 1 320 457 H62 V572.5" fill="none" stroke="' + c.bot + '" stroke-width="55" stroke-linecap="round" />';
    h += '<rect x="34.5" y="560" width="55" height="40" fill="' + c.bot + '" />';
    h += '<rect' + (animated ? ' class="ps-dot"' : '') + ' x="278" y="330" width="54" height="54" rx="10" fill="#FF7A1A" />';
    if (animated) {
      h += '<path id="na' + id + '" d="M416 30 V162 H160 A97.5 97.5 0 0 0 160 357 H212" fill="none" />';
      h += '<path id="sa' + id + '" d="M62 600 V457 H320 A98.5 98.5 0 0 0 320 260 H172" fill="none" />';
      h += '<circle r="8" fill="#fff"><animateMotion dur="2.6s" repeatCount="indefinite"><mpath href="#na' + id + '" /></animateMotion></circle>';
      h += '<circle r="8" fill="#fff"><animateMotion dur="2.6s" repeatCount="indefinite"><mpath href="#sa' + id + '" /></animateMotion></circle>';
    }
    return h + '</svg>';
  }

  /** Mark + wordmark, for headers. */
  function Logo(opts) {
    opts = opts || {};
    var variant = opts.variant === 'dark' ? 'dark' : 'light';
    var size = opts.size == null ? 32 : opts.size;
    var c = LOGO_COLORS[variant];
    return '<span class="inline-flex items-center gap-2 select-none">' +
      LogoMark({ variant: variant, size: size }) +
      '<span style="color:' + c.text + ';font-size:' + (size * 0.62) + 'px;font-weight:800;letter-spacing:-0.03em;line-height:1">' +
        'Pipeline<span style="color:' + c.sync + '">Sync</span>' +
        '<span style="color:#FF7A1A;margin-left:0.25em">AI</span>' +
      '</span>' +
    '</span>';
  }

  /* Brand palette, shared with Otto.js and with the CSS tokens in styles.css. */
  var BRAND = {
    navy: '#0C2B5E', steel: '#3E6892', steelDeep: '#2E5580',
    syncOrange: '#FF7A1A', syncOrangeHover: '#E8660A', sky: '#8FB0D0', mist: '#E8EFF7', void: '#0A0E17'
  };

  root.PSBrand = Object.assign(root.PSBrand || {}, {
    LOGO_COLORS: LOGO_COLORS,
    BRAND: BRAND,
    LogoMark: LogoMark,
    Logo: Logo
  });
})(typeof window !== 'undefined' ? window : this);
