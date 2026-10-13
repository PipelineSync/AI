# Nova Ink v5 — “Ember/Navy” neon theme (PipelineSync website): verification and assertion audit

Date: 13 October 2026 · Branch: `arena/faa98985-ai` · Supersedes: `docs/nova-ink-migration.md`

## What changed

The user asked to copy the PipelineSync website’s theme into this app and answered three
scoping questions: **the site to copy is `PipelineSync/Website` (pipelinesync.net, the
“Ember/Navy theme (elevated neon)”), the app becomes dark-only — the light theme and the
theme toggle are removed entirely (reversing the v4 dual-theme decision) — and the
PipelineSync S-mark becomes the app identity (topbar lockup, entry gate, favicon, app
icons), while Nova’s mark remains the AI’s face in the voice orb, the splash and the
done screen.** Same product flow, no IA changes, zero runtime dependencies
(`node server.js` still works), product name **Nova PipelineSync AI** unchanged.

### Design

- **One dark canvas, the site’s tokens.** `#040B16` background, `#081226` sunk panels,
  `#0E1C36` rails; text `#F4F7FF` / `#B7C3DE` / `#7C8AAB`; ember `#F97A1A` (+soft
  `#FFB25C`), sky `#4C8DFF` (+soft `#8FB6FF`), amber `#FFC24B`, green `#2FD98A`,
  red `#FF6B6B`. All declared as `:root` tokens; there is no
  `body[data-theme="light"]` block left in the stylesheet and no `data-theme`
  selector at all. `test/ui-design.js` asserts the token set and
  `color-scheme: dark`.
- **Glass returns, on the site’s recipe.** White-gradient panels
  (`linear-gradient(160deg, rgba(255,255,255,.065), rgba(255,255,255,.018))`) over
  `backdrop-filter: blur(20px) saturate(150%)`, hairline borders, the site’s inset
  top highlight and deep soft shadow `0 26px 64px -26px rgba(2,8,20,.85)`. The v4
  test asserted the *absence* of `backdrop-filter`/`blur()`; it now asserts the
  site’s glass values instead.
- **The site’s canvas.** Blue top-glow
  `radial-gradient(1100px 720px at 50% -8%, rgba(76,141,255,.16))`, the 56px
  hairline grid, and the two aurora orbs (72vmax, `blur(110px)`, ember `.orb-bg.a`
  at 34s and blue `.orb-bg.b` at 42s drift cycles). `prefers-reduced-motion`
  removes the drift; the v4 static-wash assertion is replaced by these.
- **Typography.** Space Grotesk (display, 700, `-0.025em`) over Inter body, IBM Plex
  Mono for eyebrows/pills (`.14em` tracking). Fraunces and JetBrains Mono are retired.
  The `.accent` keywords (and `.stat .k`, `.code`) ride the site’s 115deg
  blue→ember→gold gradient with `-webkit-text-fill-color: transparent` and the 8s
  `accent-shift` animation; h1 keeps the site’s blue halo.
- **Buttons.** The primary button is the site’s ember gradient fill
  (`linear-gradient(180deg, var(--sync-orange), var(--ember-soft))`) with the deep
  warm **ink** text `#1A0C02` (7.1:1 on `#F97A1A`), pill radius, inset top highlight
  and ember glow; the outline button is the site’s translucent glass with blur.
  The “no white text on any brand fill” check still passes and still applies.
- **Dark-only mechanics.** `state.theme` is pinned to `'dark'`; `applyTheme()` only
  marks `body.dataset.theme`; `#theme-toggle`, `initTheme()`, `ps_theme` and the
  gate corner slot are deleted. `test/ui-design.js` and `test/ui-smoke.js` assert
  the toggle’s absence in HTML, CSS and JS, and that both the gate and the
  signed-in topbar sit on `data-theme="dark"` from first paint.

### Brand

- **S-mark identity.** The PipelineSync S-mark
  (`public/components/brand/pipelinesync-mark.png`, 478×641 four-bit palette PNG
  copied from the website) leads every `Logo()` lockup: a white `<img class="ps-mark-img">`
  (`filter: brightness(0) invert(1) drop-shadow(0 0 10px rgba(249,122,26,.55))`,
  matching the site navbar) beside real HTML text — **Nova** (700, -0.01em) over
  **PipelineSync AI** (mono 500, uppercase, `.12em`, the **AI** in ember 700).
  Accessible name stays “Nova PipelineSync AI”.
- **Nova stays the AI’s face.** `LogoMark` is unchanged in geometry (220×140, three
  10px lines, three 9px dots, one 4-quadrant star) and recoloured: light
  `#0E1C36`/`#4C8DFF`/`#F97A1A`, dark `#4C8DFF`/`#8FB6FF`/`#F97A1A`. It renders in
  the voice orb (dark mark on the deep navy disc), the splash (animated) and the
  done screen. The mascot figure (`Nova.js`) is recoloured to the neon palette but
  is still not rendered anywhere in the app.
- **Generated assets, pure Node.** `scripts/make-brand-assets.js` no longer needs
  `@resvg/resvg-js`: it decodes the mark PNG with `zlib` and rasterizes tiles with
  its own RGBA encoder. Favicon/app icons are the deep-navy `#040B16` rounded tile
  (22% radius) with the S-mark silhouetted white via `feColorMatrix` (SVG) /
  decoded+bilinear-sampled pixels (PNG), the ember dot re-added at the mark’s own
  orange centre (measured at (0.638, 0.559), radius 0.062·W). `favicon.ico` keeps
  its 16/32/48 PNG entries; the manifest theme/background is `#040B16`.
- **Maskable safe circle.** The S-mark’s ink reaches near its canvas corners, so the
  maskable icon runs at **50% tile width** (the v4 mark fit at 60%). The test
  pixel-decodes the maskable PNG and fails if any non-navy opaque pixel (including
  the dot) lies outside the central 80%-diameter circle.

## Full suite

`npm run test:all` — 16 files, all passing, 0 failures: 1,398 checks + 4 valid
PDFs (the v4 suite ran 1,413 checks; the difference is exactly the 15
dual-theme/WCAG-pair assertions in `test/ui-design.js` that a single dark theme
makes obsolete — no assertion was deleted without a replacement).

### Additional verification

- Pixel-decoded `public/icon-512.png`: 4.2% transparent corners only, white
  silhouette 55,627 px, navy ground 188,988 px, ember dot 1,619 px sampling
  exactly `#F97A1A` at the measured centre.
- `public/icon-maskable-512.png`: 30,015 ink px (27,055 white, 771 dot),
  **0 px outside the 80% safe circle**.
- `favicon.ico`: 3 valid PNG entries (16/32/48).
- `git status`: no old PNGs survived; the v4 256px icons and `logo-*.png` exports
  are replaced; `node --check` clean on every changed JS file.

## Changed assertions: this revamp (old → new, and why)

| Where | v4 assertion | v5 assertion |
|---|---|---|
| ui-design tokens | `--sync-orange: #E8590C`, light/dark `:root` + `body[data-theme="dark"]` pairs, 26 AA pairs across both themes | neon `:root` token set (`--sync-orange #F97A1A`, `--sky #4C8DFF`, `--mist #F4F7FF`, `--void #040B16`, `--bg #040B16`); 21 AA pairs on the single dark canvas (rgba tints composited over the canvas before measuring) |
| ui-design glass | “no `backdrop-filter` and no `blur()` anywhere” | site glass: white 160deg gradient, `blur(20px) saturate(150%)`, inset top highlight, `--sh-3` deep shadow, topbar `rgba(4,11,22,.55)` + `saturate(160%)` |
| ui-design canvas | static paper wash + dot grid | blue top-glow, 56px hairline grid, aurora orbs 72vmax/`blur(110px)`/34s+42s, `color-scheme: dark`, theme-color `#040B16` |
| ui-design toggle | `#theme-toggle` present in gate + topbar, `ps_theme` persistence, `initTheme` OS-follow, gate-corner slot | all four absent in HTML/CSS/JS; `state.theme` pinned `'dark'`; body `data-theme="dark"` from first paint; no `data-theme` selector in CSS |
| ui-design lockup | `svg[aria-label]` + text **NOVA** in the lockup | `img.ps-mark-img[src="/components/brand/pipelinesync-mark.png"]` + text **Nova**; mark renders white with the site navbar ember glow; wordmark 700/500 uppercase subline, **AI** in ember 700 |
| ui-design assets | ember `#E8590C` favicon tile (paper lines, navy star); navy `#1C3D6E` app icons; 60% maskable; resvg dev-dep guard | navy `#040B16` tile, white S-mark via `feColorMatrix`, ember dot at (0.638, 0.559); 72% regular / 50% maskable; pure-Node generator (no resvg); maskable safe-circle pixel decode |
| ui-design SVG | `logo-on-dark.svg` rect fill `#14161B`; icon transforms with 14px lines | `logo-on-dark.svg` rect fill `#040B16`; favicon/app-icons tile/image/circle geometry (viewBox 512, rx 22%, image 72%/50%, dot radius 0.062·W) |
| ui-design PNG | dims + “ember star pixels” count on the app icon | dims + white silhouette count, navy ground, transparent corners, ember dot at the measured centre; maskable: all ink inside the safe circle |
| ui-design Nova | v4 palette hexes (`#1C3D6E`, `#6E88AB`, `#142C50`, `#E8590C`, `#8FA6C4`, `#F6F3EC`) | neon palette (`#4C8DFF`, `#8FB6FF`, `#03265C`, `#F97A1A`, `#FFB25C`, `#F4F7FF`); v3 **and v4** hexes on the retired negative list |
| ui-smoke | gate + topbar carry `#theme-toggle`; theme defaults light “paper” | gate + topbar carry **no** toggle; theme is the dark neon canvas on a fresh visit |
| ui-smoke selectors | `.brand-logo svg[aria-label=…]` | `.brand-logo .ps-lockup[aria-label=…]` |

### Newly added assertions (no old assertion removed)

- `rgba()` tints (the soft colours are translucent in CSS) are composited over the
  canvas before the WCAG math, so soft-tint pairs are checked like opaque ones.
- Mark contrast against the real product tile: S-mark white silhouette 19.7:1 and
  ember dot 7.3:1 on `#040B16` (both need 3:1).
- `icon-512` ground sampling (exact `#040B16` at centre), transparent corners,
  white-silhouette pixel count, ember dot at the measured centre.
- Maskable icon: every non-navy opaque pixel inside the 80% safe circle, dot
  pixels included.
- Wordmark typography (700 name, 500 mono uppercase subline, ember 700 **AI**),
  Space Grotesk + IBM Plex Mono wired into CSS and `index.html`, `accent-shift`
  8s, h1 blue halo, `.btn-primary` `--grad-ember` + `--brand-ink`, orb bg
  `rgba(4,11,22,.94)`.

## Deliberately unchanged (hard keeps)

- `brandVariant()` verbatim; every call site passes `variant: brandVariant()`.
- “Nova PipelineSync AI” in the title, manifest, PDF and email headers and the
  lockup accessible name.
- `NOVA_MARK` 220×140 geometry, paint order, animated dots + pulse, its
  reduced-motion CSS; `logoTile()` ratio.
- Zero runtime dependencies; `node server.js` serves everything; the brand
  generator is build-time only **and now dependency-free**.
- No route, environment variable, HubSpot property, `pipelinesync_ai`, Supabase
  table or test/export filename renamed.
- The a11y contract: skip link, `aria-current`/`aria-live`/`aria-expanded`,
  `:focus-visible` rings, `prefers-reduced-motion`, `forced-colors`, print
  stylesheet, 44px tap floor, safe-area insets.
- The PDF and email keep their light-document design (a printable document, not a
  screen) — only recoloured: navy `#03265C`, steel `#3A5973`, orange `#F97A1A`,
  ink `#111A2E`, borders `#D5DEED` (the white email card and the v3
  `pdf-email` test’s card assertion stand).

## Addendum — logo placement (subsequent change)

After the neon theme landed, the app's logo was simplified: the Nova star mark is
no longer rendered anywhere in the UI (the voice orb is now a plain deep-navy
disc, and the loading and done screens show no mark). The PipelineSync S-mark is
the only on-screen logo — the full lockup in the signed-in topbar, and the
S-mark alone (new `SMark` component, no wordmark) pinned to the upper-left corner
of the login screen. Only the logo was removed, not the name: **Nova AI** leads the login hero
(`.gate-name`, the accent gradient).
The `LogoMark` component and the `logo*.svg` exports are retained in the brand
library (the generator depends on them) but are no longer rendered in the app.
All design assertions were migrated (none deleted): the orb, loader and
done-screen now assert the mark's absence, and new assertions pin the S-mark to
the login screen's upper-left corner and the Nova name to the login hero.

## Related documentation

- `docs/nova-ink-migration.md` — the v4 paper/ink dual-theme audit (now superseded
  for the theme; its brand-geometry and hard-keep conventions carry forward).
- `docs/nova-brand-verification.md` — the v3 mark geometry audit.
- `README.md` — “The brand” and “UI and responsive design” sections updated to the
  neon theme in this commit.
