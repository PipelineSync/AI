/*
 * Otto — the PipelineSync AI mascot. components/brand/Otto.
 * ---------------------------------------------------------------------------
 * The PipelineSync AI React component (`components/brand/Otto.tsx`) ported to the technology this
 * app ships: plain HTML/CSS/JS, no build step, no framework. The octopus geometry, the six poses,
 * the animation CSS, the view boxes and every colour are copied from the React source character
 * for character — nothing was redrawn, simplified or recoloured. Only the mechanics changed:
 *   - JSX attributes become attributes (strokeWidth -> stroke-width, className -> class),
 *   - the components return an HTML string that the app injects with the rest of its markup,
 *   - the pose map and the copy table are exported for the app's state machine to read.
 *
 * Usage:
 *   PSBrand.Otto({ pose: "sync"|"hello"|"listen"|"speak"|"think"|"party", avatar: false,
 *                  size: 180, className: "", label: "" })
 *   PSBrand.OttoAvatar({ pose: "sync", size: 48, ring: false })
 *
 * Otto is drawn with no background of his own: no plate, no circle, no ground shadow, nothing that
 * paints behind him. He is transparent artwork on any surface, so the app decides what is behind
 * him and the same figure drops onto dark, light or an exported file unchanged.
 *
 * Rules from the brand sheet: never recolour him, never stretch him, and keep a fixed width/height
 * for the figure so a pose change cannot shift the layout.
 */
(function (root) {
  'use strict';

  var NAVY = '#0C2B5E', STEEL = '#3E6892', DEEP = '#2E5580', ORANGE = '#FF7A1A', SKY = '#8FB0D0', MIST = '#E8EFF7';

  var CSS = '\n' +
    '.otto-bob{animation:otto-bob 3s ease-in-out infinite}@keyframes otto-bob{50%{transform:translateY(-6px)}}\n' +
    '.otto-bl{transform-box:fill-box;transform-origin:center;animation:otto-bl 4.5s infinite}@keyframes otto-bl{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}\n' +
    '.otto-swL{transform-box:view-box;transform-origin:112px 168px;animation:otto-swL 2.6s ease-in-out infinite}@keyframes otto-swL{50%{transform:rotate(-7deg)}}\n' +
    '.otto-swR{transform-box:view-box;transform-origin:188px 168px;animation:otto-swR 2.6s ease-in-out infinite}@keyframes otto-swR{50%{transform:rotate(7deg)}}\n' +
    '.otto-wvR{transform-box:view-box;transform-origin:186px 166px;animation:otto-wvR 1.4s ease-in-out infinite}@keyframes otto-wvR{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(14deg)}}\n' +
    '.otto-upL{transform-box:view-box;transform-origin:114px 166px;animation:otto-upL .8s ease-in-out infinite alternate}@keyframes otto-upL{to{transform:rotate(9deg)}}\n' +
    '.otto-upR{transform-box:view-box;transform-origin:186px 166px;animation:otto-upR .8s ease-in-out infinite alternate}@keyframes otto-upR{to{transform:rotate(-9deg)}}\n' +
    '.otto-pl{transform-box:fill-box;transform-origin:center;animation:otto-pl 2s ease-in-out infinite}@keyframes otto-pl{50%{transform:scale(1.18) rotate(8deg)}}\n' +
    '.otto-tk{transform-box:fill-box;transform-origin:center;animation:otto-tk .32s ease-in-out infinite alternate}@keyframes otto-tk{from{transform:scaleY(.35)}}\n' +
    '.otto-wb{transform-box:fill-box;transform-origin:center;animation:otto-wb .8s ease-in-out infinite}@keyframes otto-wb{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1.15)}}\n' +
    '.otto-dt{animation:otto-dt 1.2s ease-in-out infinite}@keyframes otto-dt{0%,100%{opacity:.25}50%{opacity:1}}\n' +
    '.otto-snd{animation:otto-snd 1.2s ease-in-out infinite}@keyframes otto-snd{50%{opacity:.2}}\n' +
    '.otto-cf{transform-box:fill-box;transform-origin:center;animation:otto-cf 2.4s ease-in-out infinite}@keyframes otto-cf{0%,100%{transform:translateY(-5px) rotate(0)}50%{transform:translateY(6px) rotate(160deg)}}\n' +
    '@media (prefers-reduced-motion:reduce){[class^="otto-"],[class*=" otto-"]{animation:none!important}}\n';

  var ARM = {
    hold: { d: 'M114 168 C80 178 56 164 60 134', t: [60, 134], cls: 'otto-sw' },
    wave: { d: 'M114 166 C82 162 64 134 74 100 C78 90 90 88 92 98', cls: 'otto-wv' },
    up:   { d: 'M114 166 C82 150 60 118 66 80', t: [66, 80], cls: 'otto-up' },
    ear:  { d: 'M112 170 C84 174 72 152 82 128', t: [82, 128] },
    rest: { d: 'M112 170 C84 178 66 196 70 222 C72 232 84 232 86 224' },
    chin: { d: 'M124 184 C108 206 128 216 142 198', front: true }
  };

  var POSES = {
    sync:   { L: 'hold', iL: 'mail', R: 'hold', iR: 'chart', eyes: 'open', mouth: 'smile' },
    hello:  { L: 'rest', R: 'wave', eyes: 'open', mouth: 'smile' },
    listen: { L: 'ear', R: 'rest', eyes: 'side', mouth: 'smile', headset: true, sound: true },
    speak:  { L: 'rest', R: 'hold', eyes: 'open', mouth: 'talk', headset: true, bubble: true },
    think:  { L: 'chin', R: 'rest', eyes: 'up', mouth: 'o', thought: true },
    party:  { L: 'up', R: 'up', iR: 'doc', eyes: 'happy', mouth: 'grin', confetti: true }
  };

  /* Otto's copy, from the brand sheet. The app reads these so the mascot always says the same five
     things: the greeting, the listening line, the loading line, the success line and the error. */
  var COPY = {
    greeting: "Hi, I'm Otto. Let's map how your deals actually move.",
    listening: "Take your time. I'm connecting the dots as you talk.",
    loading: "One sec, I'm linking your pipeline stages together.",
    success: "Your blueprint's ready. Eight arms, zero loose ends.",
    error: "Hmm, I lost that thread. Mind saying it again?"
  };

  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { return Number(v); }
  function delayAttr(seconds) { return ' style="animation-delay:' + seconds + 's"'; }

  function Item(name, x, y, side) {
    var rot = side === 'L' ? -8 : 8;
    if (name === 'mail') return '<g transform="translate(' + (x - 21) + ' ' + (y - 32) + ') rotate(' + rot + ' 21 15)">' +
      '<rect width="42" height="30" rx="5" fill="#fff" stroke="' + NAVY + '" stroke-width="3" />' +
      '<path d="M4 5 L21 17 L38 5" fill="none" stroke="' + ORANGE + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></g>';
    if (name === 'chart') return '<g transform="translate(' + (x - 23) + ' ' + (y - 42) + ') rotate(' + rot + ' 23 19)">' +
      '<rect width="46" height="38" rx="6" fill="#fff" stroke="' + NAVY + '" stroke-width="3" />' +
      '<rect x="9" y="22" width="6" height="9" rx="1.5" fill="' + SKY + '" />' +
      '<rect x="20" y="16" width="6" height="15" rx="1.5" fill="' + STEEL + '" />' +
      '<rect x="31" y="9" width="6" height="22" rx="1.5" fill="' + ORANGE + '" /></g>';
    return '<g transform="translate(' + (x - 20) + ' ' + (y - 52) + ') rotate(' + rot + ' 20 26)">' +
      '<rect width="40" height="50" rx="5" fill="#fff" stroke="' + NAVY + '" stroke-width="3" />' +
      '<path d="M9 12 H31 M9 20 H27 M9 28 H22" stroke="' + SKY + '" stroke-width="3" stroke-linecap="round" />' +
      '<circle cx="28" cy="38" r="8" fill="' + ORANGE + '" />' +
      '<path d="M24 38 L27 41 L32 35" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></g>';
  }

  function Arm(side, k, item) {
    var a = ARM[k];
    var tip = a.t ? [side === 'R' ? 300 - a.t[0] : a.t[0], a.t[1]] : null;
    return '<g' + (a.cls ? ' class="' + a.cls + side + '"' : '') + '>' +
      '<path d="' + a.d + '"' + (side === 'R' ? ' transform="translate(300 0) scale(-1 1)"' : '') +
        ' fill="none" stroke="' + STEEL + '" stroke-width="18" stroke-linecap="round" />' +
      (item && tip ? Item(item, tip[0], tip[1], side) : '') +
    '</g>';
  }

  function Eyes(k) {
    if (k === 'happy') return '<path d="M116 134 Q128 118 140 134 M160 134 Q172 118 184 134" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" />';
    var d = { open: [3, 2], up: [2, -5], side: [-5, 1] }[k];
    var dx = d[0], dy = d[1];
    return '<g class="otto-bl">' +
      '<circle cx="128" cy="128" r="16" fill="#fff" /><circle cx="172" cy="128" r="16" fill="#fff" />' +
      '<circle cx="' + (128 + dx) + '" cy="' + (128 + dy) + '" r="8" fill="' + NAVY + '" /><circle cx="' + (172 + dx) + '" cy="' + (128 + dy) + '" r="8" fill="' + NAVY + '" />' +
      '<circle cx="' + (131 + dx) + '" cy="' + (124 + dy) + '" r="2.8" fill="#fff" /><circle cx="' + (175 + dx) + '" cy="' + (124 + dy) + '" r="2.8" fill="#fff" />' +
    '</g>';
  }

  function Mouth(k) {
    if (k === 'talk') return '<ellipse class="otto-tk" cx="150" cy="160" rx="9" ry="7" fill="#fff" />';
    if (k === 'o') return '<circle cx="156" cy="160" r="4.5" fill="#fff" />';
    if (k === 'grin') return '<path d="M134 152 Q150 174 166 152 Z" fill="#fff" />';
    return '<path d="M138 156 Q150 166 162 156" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" />';
  }

  var CONFETTI = [[40, 40, ORANGE, 20], [76, 22, STEEL, 60], [252, 112, SKY, 10], [26, 104, NAVY, 45], [272, 160, ORANGE, 70], [22, 168, SKY, 30], [118, 20, ORANGE, 80], [190, 16, NAVY, 15], [282, 90, STEEL, 50], [56, 146, ORANGE, 35], [158, 32, SKY, 65]];

  /** Otto, in one of six poses. */
  function Otto(opts) {
    opts = opts || {};
    var pose = POSES[opts.pose] ? opts.pose : 'sync';
    var avatar = !!opts.avatar;
    var size = opts.size;
    var o = POSES[pose];
    var arms = [['L', o.L, o.iL], ['R', o.R, o.iR]];
    // In avatar mode, hide extras that sit outside the head crop
    var bubble = o.bubble && !avatar, thought = o.thought && !avatar, sound = o.sound && !avatar, confetti = o.confetti && !avatar;
    var label = opts.label || ('Otto the PipelineSync octopus (' + pose + ')');
    var h = '<svg viewBox="' + (avatar ? '66 36 168 168' : '0 0 300 300') + '"' +
      ' width="' + (size == null ? '100%' : size) + '"' +
      (size == null ? '' : ' height="' + size + '"') +
      ' role="img" aria-label="' + escAttr(label) + '"' +
      (opts.className ? ' class="' + escAttr(opts.className) + '"' : '') + '>';
    h += '<style>' + CSS + '</style>';
    h += '<g class="otto-bob">';
    // Legs (behind the head), then the four lower arms, then the head, then everything in front.
    h += '<g fill="none" stroke="' + DEEP + '" stroke-width="16" stroke-linecap="round">' +
      '<path d="M144 190 C138 236 128 262 118 272" /><path d="M156 190 C162 236 172 262 182 272" /></g>';
    h += '<g fill="none" stroke="' + STEEL + '" stroke-width="18" stroke-linecap="round">' +
      '<path d="M120 186 C100 222 66 232 48 214 C40 206 44 194 54 196" />' +
      '<path d="M180 186 C200 222 234 232 252 214 C260 206 256 194 246 196" />' +
      '<path d="M136 192 C132 230 114 250 94 256" />' +
      '<path d="M164 192 C168 230 186 250 206 256" /></g>';
    h += '<g fill="' + MIST + '"><circle cx="125" cy="229" r="3" /><circle cx="111" cy="247" r="3" /><circle cx="175" cy="229" r="3" /><circle cx="189" cy="247" r="3" /></g>';
    arms.filter(function (a) { return !ARM[a[1]].front; }).forEach(function (a) { h += Arm(a[0], a[1], a[2]); });
    h += '<path d="M92 172 C84 100 116 56 150 56 C184 56 216 100 208 172 C188 190 112 190 92 172 Z" fill="' + NAVY + '" />';
    if (!o.headset) h += '<path d="M112 92 C120 76 134 68 148 67" fill="none" stroke="' + STEEL + '" stroke-width="6" stroke-linecap="round" />';
    h += '<rect class="otto-pl" x="141" y="80" width="18" height="18" rx="4.5" fill="' + ORANGE + '" />';
    h += Eyes(o.eyes);
    h += Mouth(o.mouth);
    h += '<circle cx="110" cy="152" r="6" fill="' + ORANGE + '" opacity="0.4" /><circle cx="190" cy="152" r="6" fill="' + ORANGE + '" opacity="0.4" />';
    if (o.headset) {
      h += '<g>' +
        '<path d="M92 122 C92 40 208 40 208 122" fill="none" stroke="' + STEEL + '" stroke-width="7" stroke-linecap="round" />' +
        '<rect x="82" y="106" width="18" height="32" rx="9" fill="' + STEEL + '" /><rect x="200" y="106" width="18" height="32" rx="9" fill="' + STEEL + '" />' +
        '<path d="M209 134 C211 160 194 170 178 166" fill="none" stroke="' + STEEL + '" stroke-width="4" stroke-linecap="round" />' +
        '<rect x="166" y="161" width="13" height="9" rx="4" fill="' + ORANGE + '" />' +
      '</g>';
    }
    arms.filter(function (a) { return ARM[a[1]].front; }).forEach(function (a) { h += Arm(a[0], a[1], a[2]); });
    if (sound) {
      h += '<g class="otto-snd" fill="none" stroke="' + ORANGE + '" stroke-width="3" stroke-linecap="round">' +
        '<path d="M62 114 q-7 12 0 24" /><path d="M52 106 q-11 20 0 40" opacity="0.6" />' +
      '</g>';
    }
    if (bubble) {
      h += '<g>' +
        '<path d="M204 30 H268 Q280 30 280 42 V62 Q280 74 268 74 H222 L208 86 L212 74 H204 Q192 74 192 62 V42 Q192 30 204 30 Z" fill="#fff" stroke="' + NAVY + '" stroke-width="3" stroke-linejoin="round" />';
      [-0.1, -0.4, -0.2, -0.6, -0.3, -0.5, -0.15].forEach(function (d, i) {
        h += '<rect class="otto-wb" x="' + (208 + i * 9) + '" y="44" width="5" height="16" rx="2.5" fill="' + (i % 3 === 1 ? ORANGE : STEEL) + '"' + delayAttr(d) + ' />';
      });
      h += '</g>';
    }
    if (thought) {
      h += '<g>' +
        '<circle cx="206" cy="78" r="5" fill="#fff" stroke="' + NAVY + '" stroke-width="2.5" />' +
        '<circle cx="220" cy="60" r="8" fill="#fff" stroke="' + NAVY + '" stroke-width="2.5" />' +
        '<ellipse cx="252" cy="34" rx="36" ry="22" fill="#fff" stroke="' + NAVY + '" stroke-width="3" />';
      [240, 252, 264].forEach(function (x, i) {
        h += '<circle class="otto-dt" cx="' + x + '" cy="34" r="4" fill="' + NAVY + '"' + delayAttr(i * 0.2) + ' />';
      });
      h += '</g>';
    }
    h += '</g>';
    if (confetti) {
      CONFETTI.forEach(function (c, i) {
        h += '<rect class="otto-cf" x="' + c[0] + '" y="' + c[1] + '" width="9" height="5" rx="1.5" fill="' + c[2] + '"' +
          ' transform="rotate(' + c[3] + ' ' + (c[0] + 4) + ' ' + (c[1] + 2) + ')"' + delayAttr(-(i * 0.3)) + ' />';
      });
    }
    return h + '</svg>';
  }

  /** Round avatar wrapper: a bare head with an optional orange ring. Transparent, so the surface
      behind it shows through and the ring stays the only thing drawn around Otto. */
  function OttoAvatar(opts) {
    opts = opts || {};
    var pose = POSES[opts.pose] ? opts.pose : 'sync';
    var size = opts.size == null ? 48 : opts.size;
    var ring = !!opts.ring;
    return '<span class="relative inline-block rounded-full" style="width:' + num(size) + 'px;height:' + num(size) + 'px' +
      (ring ? ';box-shadow:0 0 0 3px ' + ORANGE : '') + '">' +
      Otto({ pose: pose, avatar: true, size: size }) +
    '</span>';
  }

  root.PSBrand = Object.assign(root.PSBrand || {}, {
    OTTO_POSES: Object.keys(POSES),
    OTTO_COPY: COPY,
    OTTO_COLORS: { navy: NAVY, steel: STEEL, steelDeep: DEEP, syncOrange: ORANGE, sky: SKY, mist: MIST },
    Otto: Otto,
    OttoAvatar: OttoAvatar
  });
})(typeof window !== 'undefined' ? window : this);
