# Nova Ink v4 — full UI/UX + theme revamp: verification and assertion audit

Date: 13 October 2026 · Branch: `arena/faa98985-ai`

## What changed

The user asked for a full UI/UX and theme revamp and answered four scoping questions:
**light editorial “paper & ink” direction, a full rebrand (new palette AND new logo treatment),
theme + layout/typography only (same product flow), and a true dual theme with the toggle
restored and tested in both modes.** This document records the result and every assertion
migration, in the convention of `docs/nova-brand-verification.md`.

### Design

- **Dual “Nova Ink” system.** Light **paper** is the default: warm off-white canvas
  `#F6F3EC`, flat white panels, hairline rules, Fraunces display type over Inter body and
  JetBrains Mono. Dark **ink** is one click away: void `#14161B`, `#1B1F26` panels,
  brighter ember `#F76B15`. All legacy class names and layout metrics (1120px centered
  canvas, 760px voice panel, 100dvh entry lock, 44px tap floor) are unchanged; the IA and
  every product flow are unchanged.
- **Zero glass, zero blur.** The v3 `backdrop-filter` glass, glow shadows and animated
  aurora drift are gone. The background is a static radial paper wash plus a dot grid;
  `test/ui-design.js` now asserts there is **no `backdrop-filter` and no `blur()`**
  anywhere in the stylesheet.
- **Restored theme toggle** (`#theme-toggle`) in the entry-gate corner and the signed-in
  topbar. `initTheme()` follows the OS `prefers-color-scheme` on a fresh visit and
  persists the choice in `ps_theme`; `applyTheme()` flips `body[data-theme]`, the colour
  scheme and the `theme-color` meta (`#F6F3EC` / `#14161B`) together. Because the brand
  marks are inline SVGs with baked colours, `setTheme()` re-renders only those
  (topbar, gate, splash) — and skips the full re-render mid-call, where a live call must
  not be torn down. One delegated document listener drives both buttons.
- **Buttons.** The primary button is the ember fill with **ink** text (`--brand-ink`),
  which clears 4.5:1 in both themes; the old white-on-orange label is gone and the test
  now asserts *no* rule paints white text on a brand fill.

### Brand (full rebrand, per the user’s explicit decision)

- **New mark geometry.** `NOVA_MARK` is now a 220×140 viewbox: three straight 10px
  round-capped lines converging on the centre, three 9px dots at their origins, and one
  4-quadrant star. The v3 spark is removed. Paint order: 3 paths → 3 circles → star.
  `LogoMark`/`Logo` APIs, the animated offset-path dots, the star pulse and the exact
  reduced-motion string are retained.
- **New palette** (`LOGO_COLORS`, `BRAND`): light ink `#1B1E24` lines / steel `#6E88AB`
  dots / ember `#E8590C` star; dark mist `#EDEAE1` / sky `#8FA6C4` / ember `#F76B15`.
  Brand constants: navy `#1C3D6E`, steel-deep `#142C50`, sky `#8FA6C4`, paper `#F6F3EC`,
  void `#14161B`.
- **Nova recoloured in place.** `public/components/brand/Nova.js` keeps every pose, the
  animation CSS, both view boxes and transparent-artwork rules; only the six palette
  constants changed (navy `#1C3D6E`, steel `#6E88AB`, deep `#142C50`, orange `#E8590C`,
  sky `#8FA6C4`, mist `#F6F3EC`). The test now asserts the new literals **and** that the
  old six are fully gone.
- **All ten assets regenerated** (`npm run brand:icons`): ember favicon tile
  (`#E8590C`, paper lines/dots, deep-navy `#17335C` star), navy app tiles
  (`#1C3D6E`, paper lines, sky dots, ember star), dark standalone on `#14161B`, new
  620×170 lockups (Fraunces-metric 600 NOVA, 0.14em), maskable artwork at 60% width
  inside the 80% safe circle. `@resvg/resvg-js` stays a build-time-only tool.
- **Documents recoloured.** Client pdfmake PDF (navy `#1C3D6E` headers, ember accents,
  warm neutrals), server PDF header (navy brand name, muted rule label, ember rule, ink
  body), and the email BRAND object (`#1C3D6E`/`#6E88AB`/`#E8590C` on paper `#F6F3EC`).
  Product names in the PDF/email/manifest/title are unchanged.

## Full suite

`npm run test:all` completed with exit code **0** on 13 October 2026. All 16 files
passed; zero failures, no skipped PDF validation.

| File in `test/` | Passing checks | Failures |
|---|---:|---:|
| `supabase-leads.js` | 10 (native, silent on success) | 0 |
| `voice.js` | 108 | 0 |
| `voice-memory.js` | 27 (native) | 0 |
| `voice-openai.js` | 24 | 0 |
| `voice-realtime.js` | 257 | 0 |
| `e2e.js` | 85 | 0 |
| `pdf-email.js` | 84 | 0 |
| `netlify-sim.js` | 113 | 0 |
| `claude-pipeline.js` | 80 | 0 |
| `pdfcheck.js` | 4 PDFs; 36 xrefs + 4 trailers | 0 |
| `ui-design.js` | 184 | 0 |
| `ui-smoke.js` | 316 | 0 |
| `turnstile.js` | 17 | 0 |
| `demo-and-limits.js` | 25 | 0 |
| `consent.js` | 25 | 0 |
| `zero-touch.js` | 58 | 0 |

**Total: 1,413 passing checks plus four valid PDFs (36 cross-reference offsets and four
trailers); zero failures.**

### Additional verification

- Theme toggle driven end-to-end in a jsdom boot against a real server: fresh visit
  `light` + meta `#F6F3EC` → click → `dark` + meta `#14161B` + `ps_theme=dark` +
  gate/topbar marks re-tinted to the dark palette + aria-label flipped → click → back to
  `light` with `ps_theme=light`.
- `npm run brand:icons` output verified file-by-file (geometry, palette, transform,
  PNG dimensions) before the suite run.
- `git diff --check` clean. No runtime dependency added; `@resvg/resvg-js` installed
  with `--no-save --package-lock=false` exactly as the build script documents.

### Measured contrast (selected)

| Foreground / surface | Theme | Ratio | Required |
|---|---|---:|---:|
| Ink `#1B1E24` / paper `#F6F3EC` | paper | 14.66:1 | 4.5:1 |
| Ember `#E8590C` fill / ink text `#1B1E24` (primary button) | paper | 4.66:1 | 4.5:1 |
| Ember `#F76B15` fill / ink text `#14161B` (primary button) | ink | 6.09:1 | 4.5:1 |
| Light mark lines / white | paper | 15.94:1 | 3:1 |
| Dark mark star `#F76B15` / void `#14161B` | ink | 6.09:1 | 3:1 |
| Paper lines / navy tile `#1C3D6E` | icon | 9.74:1 | 3:1 |
| Ember star / navy tile | icon | 3.64:1 | 3:1 |
| Deep-navy star / ember tile `#E8590C` | icon | 3.53:1 | 3:1 |

The full pair list (26 pairs × 2 themes) is what `test/ui-design.js` asserts.

## Changed assertions: this revamp (old → new, and why)

All entries refer to `test/ui-design.js` unless another file is named.

| # | Old assertion | New assertion | Why |
|---:|---|---|---|
| 1 | Primary button may carry white text (`.btn-primary` exempted) | **No** rule paints white text on a brand fill; `.btn-primary` fill is `var(--sync-orange)` and its label is `var(--brand-ink)` | The ink-text ember button clears 4.5:1, so the v3 2.55:1 white-on-orange exception is retired. |
| 2 | Tokens declared: `--sync-orange:#FF7A1A`, `--sky:#8FB0D0`, `--mist:#E8EFF7`, `--void:#0A0E17`, `--bg:#0A0E17` | Tokens declared: `--sync-orange:#E8590C`, `--sky:#6E88AB`, `--mist:#F6F3EC`, `--void:#14161B`, `--bg:#F6F3EC` | Rebrand: the paper default replaces the dark-only canvas. |
| 3 | WCAG AA pairs read from the single `:root` block only | The same machinery now resolves **two** token blocks (`:root` paper and `body[data-theme="dark"]` ink) and asserts 26 pairs per theme | Dual theme: both surfaces must be AA, not just one. |
| 4 | Pairs referenced v3 values (white on `--navy` button, `#CBDCE9` on navy, `#FFC08A` headline, `#0C2B5E`/`#3E6892`/`#8FB0D0` mark colours, navy/orange stars on `#0C2B5E`/`#FF7A1A` tiles) | Pairs reference v4 values (ink on ember button in both themes, ink/req on `--ember-soft`, `#1B1E24`/`#6E88AB`/`#E8590C` on white, `#EDEAE1`/`#8FA6C4`/`#F76B15` on `#14161B`, paper/ember stars on `#1C3D6E`, deep-navy star on `#E8590C`) | Each replaced pair still measures a real on-screen text/background or mark/surface combination, now at its v4 values. |
| 5 | Mark: `-10 16 222 162` viewBox, 5 paths (3 lines sw14, star, spark), 3 dots r12, paint order incl. spark | Mark: `0 0 220 140` viewBox, 4 paths (3 lines sw10, star), 3 dots r9, exact new star path, paint order `path,path,path,circle,circle,circle,path`, **no spark** | The rebrand’s new geometry, pinned exactly as before — replaced, not deleted. |
| 6 | Mark palettes `#0C2B5E`/`#3E6892` (light), `#E8EFF7`/`#8FB0D0` (dark), star `#FF7A1A` | `#1B1E24`/`#6E88AB` (light), `#EDEAE1`/`#8FA6C4` (dark), stars `#E8590C`/`#F76B15` | New brand palette. |
| 7 | Wordmark 800 NOVA / 0.09em, 600 subline, literal `color:#FF7A1A;font-weight:800` in source | 600 NOVA / 0.14em, 500 subline, `font-weight:700">AI</span>` in source plus `LOGO_COLORS.light.star === '#E8590C'` and `.dark.star === '#F76B15'` | The rebrand’s typographic scale; the star colour is now read from the component’s own exported palette instead of a hard-coded literal the component no longer contains. |
| 8 | Orb CSS contains `rgba(10, 14, 23, 0.9)` | Orb CSS contains `rgba(20, 22, 27, 0.92)` and the dark 24px mark call is unchanged | The orb is the same permanent dark disc, recoloured to the v4 void. |
| 9 | `logoTile` width is `h * 222 / 162` | `h * 220 / 140` | New aspect ratio; the no-plate/no-shadow rules are retained. |
| 10 | Favicon `#FF7A1A` tile, white lines/dots sw16, dots r13, navy star; app icon `#0C2B5E` tile, sky dots, orange star; transform must end `translate(10 -16)` | Favicon `#E8590C` tile, paper lines/dots sw14, dots r12, deep-navy star; app icon `#1C3D6E` tile, sky dots, ember star; centring computed against 220×140 with no offset tail | Regenerated assets with the new geometry and v4 tiles. |
| 11 | Dark standalone rect fill `#0A0E17` | `#14161B` | The void token moved with the rebrand. |
| 12 | Maskable PNG: navy background `[12,43,94]`, star pixels `#FF7A1A` | Navy `[28,61,110]` (`#1C3D6E`), star pixels `#F76B15` | Same premultiplied-channel technique, new ground and star. |
| 13 | Manifest `theme_color` and `background_color` are `#0A0E17` | Both are `#F6F3EC` | The PWA’s default shell is the paper theme. |
| 14 | Nova.js palette literals `#0C2B5E`/`#3E6892`/`#FF7A1A`/`#8FB0D0`/`#E8EFF7` “and nothing else” | New literals `#1C3D6E`/`#6E88AB`/`#142C50`/`#E8590C`/`#8FA6C4`/`#F6F3EC` present **and** the old six asserted absent | A recolour must be complete in both directions. |
| 15 | Waveform described as “the #8FB0D0 → #FF7A1A gradient” | Same structural check (`linear-gradient(180deg, var(--sky) 0%, var(--sync-orange) 100%)`), message updated to “the sky → ember gradient” | The gradient is now token-based and therefore theme-correct; the pinned string already was tokens. |
| 16 | *(in `test/ui-smoke.js`)* “there is no colour-mode switch on the entry gate” + `dataset.theme === 'dark'` | `#theme-toggle` **present** on the entry gate + `dataset.theme === 'light'` on a fresh visit | The toggle was restored and light is now the default; same check site, inverted contract. |
| 17 | *(in `test/ui-smoke.js`)* “the signed-in dashboard has no colour-mode switch” + “stays dark” | `#theme-toggle` present in the topbar (and `.theme-switch-top` still absent) + defaults to `light` | Same, for the signed-in surface. |

### Newly added assertions (no old assertion removed)

1. **Dual-theme section**: `body[data-theme="dark"]` is a real token block carrying
   `--bg: #14161B` and `--sync-orange: #F76B15`; no `backdrop-filter` and no `blur()`
   anywhere; the `.orb-bg` wash rules carry no animation; `index.html` declares
   `color-scheme="light dark"` and a paper `theme-color`.
2. Theme machinery in `app.js`: `initTheme()` + `ps_theme` persistence, `applyTheme()`
   flipping body attribute / colour scheme / meta, the toggle’s dynamic
   `aria-label="Switch to … theme"`, the single delegated `#theme-toggle` listener, the
   `brand-topbar`/`brand-gate`/`brand-splash` in-place re-render ids, the
   mid-call guard (`if (state.stage !== 'intake') render()`), and the `.gate-corner`
   CSS slot.
3. Fraunces is wired into both `styles.css` (`--display`) and the `index.html` font link.
4. `.noscript` fallback is styled on the paper surface.
5. The `.specular` glass sweep is explicitly retired (`content: none`).

## Deliberately unchanged (hard keeps)

- Product name **Nova PipelineSync AI** in the title, manifest, PDF (browser +
  server) and email; `Nova` short name.
- `brandVariant()` source byte-for-byte; the orb’s permanent
  `LogoMark({ variant: 'dark', size: 24 })`; no fixed light mark on any
  theme-following surface; no white logo plates.
- All IA/flow: entry gate → consent → call → (zero-touch or review) → blueprint →
  deliver → book. No route, env var, HubSpot property, `pipelinesync_ai`, Supabase
  table or test/export filename renamed.
- Accessibility contract: skip link, `aria-live`, `aria-current`, `aria-expanded`,
  `:focus-visible`, reduced-motion (including the exact Logo.js reduced-motion string),
  forced-colors, print, 44px tap floor, safe-area insets.
- Zero runtime dependencies; `node server.js` still runs the whole product.

## Related documentation

- `docs/nova-brand-verification.md` — the v3 brand migration this superseded (its
  “never recolour” rule is explicitly overridden by this revamp, per the user’s
  full-rebrand decision).
- README “The brand” and “UI and responsive design” sections were rewritten to
  describe Nova Ink v4 (dual theme, new geometry, new tiles).
