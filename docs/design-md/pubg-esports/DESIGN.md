---
version: alpha
name: PUBG-Esports-Inspired-design-analysis
description: An inspired interpretation of PUBG Esports' design language — a dark esports aesthetic built on pure black canvas, high-contrast white text, neon yellow-green accent, and military olive-green functional color. Zero border-radius, zero box-shadow, tight letter-spacing (-0.48px), all-flat composition — the visual identity of competitive gaming.

colors:
  primary: "#eff923"
  primary-deep: "#909615"
  on-primary: "#000000"
  ink: "#ffffff"
  body: "rgba(255,255,255,0.5)"
  mute: "#999999"
  mute-2: "#aaaaaa"
  canvas: "#000000"
  canvas-soft: "#000000"
  canvas-soft-2: "#000000"
  hairline: "#333333"
  surface-muted: "#333333"
  surface-mid: "#555555"
  link: "#ffffff"
  error: "#eff923"

typography:
  display-xl:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: -0.48px
  display-lg:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 20px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: -0.48px
  display-md:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: -0.48px
  body-lg:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.48px
  body-md:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: -0.48px
  body-sm:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: -0.48px
  body-sm-strong:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 13px
    fontWeight: 700
    lineHeight: 13px
    letterSpacing: -0.48px
  caption:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: -0.48px
  caption-strong:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: -0.48px
  micro:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.48px
  button-md:
    fontFamily: "SourceHanSansCN, Pretendard, -apple-system, 'Segoe UI', roboto, sans-serif"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: -0.5px

rounded:
  none: 0px
  sm: 0px
  md: 0px
  lg: 0px
  xl: 0px
  pill: 0px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 40px
  3xl: 80px
  section: 80px

components:
  nav-bar:
    backgroundColor: "#000000"
    textColor: "#ffffff"
    typography: "{typography.body-sm}"
    height: 80px
    padding: 0px 40px
  nav-link:
    textColor: "#ffffff"
    typography: "{typography.body-sm}"
    letterSpacing: -0.48px
  tag-accent:
    backgroundColor: "#000000"
    textColor: "#eff923"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.none}"
    padding: 6.5px 10px
  tag-muted:
    backgroundColor: transparent
    textColor: "rgba(255,255,255,0.5)"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.none}"
  card-event:
    backgroundColor: "#000000"
    textColor: "#ffffff"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    padding: 0px
  card-media:
    backgroundColor: "#000000"
    textColor: "#ffffff"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    padding: 0px
  button-primary:
    backgroundColor: "transparent"
    textColor: "#ffffff"
    typography: "{typography.button-md}"
    rounded: "{rounded.none}"
    letterSpacing: -0.48px
  button-cta:
    backgroundColor: "transparent"
    textColor: "#ffffff"
    typography: "{typography.body-sm}"
    rounded: "{rounded.none}"
  footer:
    backgroundColor: "#000000"
    textColor: "#ffffff"
    typography: "{typography.caption}"
    padding: "{spacing.xl} {spacing.2xl}"
  link-inline:
    textColor: "#ffffff"
    typography: "{typography.body-md}"
---

## Overview

PUBG Esports uses a **Dark Esports Aesthetic** — extreme, sharp, high-contrast, content-first. The page is a pure black canvas (`{colors.canvas}` — `#000000`) onto which white text (`{colors.ink}` — `#ffffff`) carries all information hierarchy. The single accent is a high-saturation neon yellow-green (`{colors.primary}` — `#EFF923`) used exclusively for hover states, active indicators, and critical CTAs. A deeper olive-green (`{colors.primary-deep}` — `#909615`) serves as a functional color for match times and status labels.

This is a **zero-decoration system**: zero border-radius, zero box-shadow, zero gradients. Every element is sharp-cornered and flat. Depth comes from color contrast alone, not from shadow elevation. The global `letter-spacing: -0.48px` tightens every character, creating a compact, competitive feel. Surface hierarchy is minimal — black for the page, a dark gray `{colors.surface-muted}` (`#333333`) for card/dividing elements, and that's it.

**Key Characteristics:**
- Pure black `#000000` canvas across the entire site — no off-black, no dark gray background
- Neon yellow-green `#EFF923` accent — used ONLY for hover and key emphasis, never as body text
- Zero border-radius globally — the sharp-cornered identity is the most distinctive esports signal
- Zero box-shadow — completely flat composition, contrast replaces depth
- Global `-0.48px` letter-spacing — tight tracking on every text element
- Text hierarchy via opacity: 100% (headings/body), 50% (secondary labels), lower percentages (muted)
- Military olive-green `#909615` for functional information (match times, status)
- Transition defaults to `ease-in-out` / `ease-out`

## Colors

### Brand & Accent
- **Neon Yellow-Green** (`{colors.primary}` — `#EFF923`): The signature accent color. Used exclusively for hover states, active indicators, and critical CTA elements. Never appears as body text or structural chrome.
- **Olive-Green** (`{colors.primary-deep}` — `#909615`): Functional color for match times, status labels, and secondary metadata. The deeper, muted counterpart to the neon accent.

### Surface
- **Canvas** (`{colors.canvas}` — `#000000`): Pure black page background. Every section, every card, every band sits on this single surface tone — no gradient, no alternation.
- **Surface Muted** (`{colors.surface-muted}` — `#333333`): Dark gray used for card backgrounds, dividers, and structural chrome that needs to separate from pure black.
- **Surface Mid** (`{colors.surface-mid}` — `#555555`): Secondary gray for auxiliary elements.

### Text
- **Ink** (`{colors.ink}` — `#ffffff`): Universal text color on black surfaces — headings, body, card titles.
- **Body** (`{colors.body}` — `rgba(255,255,255,0.5)`): Secondary text — dates, category labels, auxiliary information. 50% white opacity.
- **Mute** (`{colors.mute}` — `#999999`): Tertiary text — lowest-priority labels, fine print.
- **Mute 2** (`{colors.mute-2}` — `#aaaaaa`): Alternate tertiary text level.
- **On Primary** (`{colors.on-primary}` — `#000000`): Text on neon accent surfaces.

### Semantic
The system is minimal — no separate error/success palette. The neon accent doubles as an attention color; the olive-green doubles as a status indicator.

## Typography

### Font Family
Two primary faces carry the system:

1. **SourceHanSansCN** (Noto Sans CJK) — loaded via Adobe Typekit. Weights 400/500/700/900. The primary CJK face for all text.
2. **Pretendard** — self-hosted variable. Weights 100–900. The Latin/Korean complement to SourceHanSansCN, loaded at full weight range.

Fallback chain: `SourceHanSansCN, Pretendard, blinkmacsystemfont, -apple-system, "Segoe UI", roboto, oxygen, ubuntu, cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", helvetica, arial, sans-serif`

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-xl}` | 28px | 700 | 1.5 | -0.48px | Page titles |
| `{typography.display-lg}` | 20px | 700 | 24px | -0.48px | Date numbers, card titles |
| `{typography.display-md}` | 18px | 700 | 1.5 | -0.48px | Sub-headings |
| `{typography.body-lg}` | 16px | 400 | 1.5 | -0.48px | Body text |
| `{typography.body-md}` | 15px | 400 | 16px | -0.48px | Match names |
| `{typography.body-sm}` | 14px | 700 | 1.5 | -0.48px | Small bold headings |
| `{typography.body-sm-strong}` | 13px | 700 | 13px | -0.48px | Category tags |
| `{typography.caption}` | 13px | 400 | 16px | -0.48px | Match stage, dates, categories |
| `{typography.caption-strong}` | 13px | 600 | 1.5 | -0.48px | Match times |
| `{typography.micro}` | 12px | 400 | 1.5 | -0.48px | Smallest labels |
| `{typography.button-md}` | 24px | 700 | 1.0 | -0.5px | Navigation button labels |

### Principles
- **Global -0.48px tracking.** Every text element on the page uses this tracking. It is the single most identifiable typographic feature. Removing it immediately loses the esports feel.
- **Weight 700 is the emphasis ceiling.** Bold uses 700; titles use 700; there is no 800/900 in body context.
- **Opacity-based hierarchy.** Text hierarchy is controlled by opacity (100% → 50% → lower), not by font-size alone. Secondary labels at 13px 400-weight with 50% opacity read as "metadata"; primary text at 100% reads as "content."
- **All weights loaded.** Pretendard loads 100–900 globally, but the working set is 400 (body), 500 (medium emphasis), 600 (captions), 700 (headings), 900 (special).

### Font Substitutes
Both primary faces are open-source. For CJK: **Noto Sans SC** via Google Fonts is the closest equivalent. For Latin/Korean: **Inter** at weight 400/700 with `-0.48px` letter-spacing approximates Pretendard's rhythm at body sizes. Avoid system-ui defaults — they're heavier than the esports aesthetic needs.

## Layout

### Spacing System
- **Base unit**: 4px.
- **Tokens**: `{spacing.xs}` 4px · `{spacing.sm}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 16px · `{spacing.xl}` 24px · `{spacing.2xl}` 40px · `{spacing.3xl}` 80px.
- **Navigation**: 80px height with 40px horizontal padding. 72px on mobile (≤768px).
- **Main content**: `padding-top: 80px` to clear the fixed navigation.
- **Card interior**: tight 6px gaps between elements within event cards.

### Grid & Container
- Full-width content with navigation at edges. No max-width container — content flows edge-to-edge within the navigation gutter.
- Event cards arranged in horizontal rows, date-left + info-right layout.
- Media cards in vertical grid: thumbnail top, category tag + title below.

### Whitespace Philosophy
The site uses tight interior spacing (6px within cards) with generous navigation gutters (40px). Content density is high — the esports audience expects data density, not breathing room. This is the opposite of SaaS marketing whitespace.

### Responsive Strategy

| Name | Width | Key Changes |
|---|---|---|
| Desktop | > 1024px | Full layout, 80px nav |
| Tablet | ≤ 1024px | Nav stays 80px, content reflows |
| Mobile | ≤ 768px | Nav drops to 72px; min-height calc(100vh - 482px) |

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Level 0 — Flat | No shadow, no border, pure color contrast | Every element on the site |

This system has **no elevation** — it's a completely flat design. Depth comes from color contrast: white text on black canvas, dark gray `{colors.surface-muted}` separating black-from-black. The absence of shadow is as deliberate a choice as the absence of border-radius — together they define the esports aesthetic.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Every element — cards, buttons, tags, images, containers |
| `{rounded.full}` | 9999px | Circular containers only (if ever needed) |

The entire site uses `border-radius: 0`. Cards, buttons, image containers, category tags — all sharp-cornered. This is the most distinctive visual feature and the #1 rule of the system: **zero rounded corners, always**. Full-round (9999px) exists as an escape hatch but is never used in the marketing surface.

## Components

### Navigation

**`nav-bar`** — Fixed top navigation.
- Background `#000000`, text `#ffffff`, height 80px (72px mobile), padding `0px 40px`. Layout: logo image left, nav links center, "PLAY NOW" CTA right. Hover: links turn `{colors.primary}` `#EFF923`.

**`nav-link`** — Centered navigation link.
- Text `#ffffff`, `{typography.body-sm}` (14px / 700), `letter-spacing: -0.48px`. Hover state: color shifts to `{colors.primary}`.

### Tags

**`tag-accent`** — Neon accent category tag.
- Background `#000000`, text `{colors.primary}` `#EFF923`, `{typography.body-sm-strong}` (13px / 700 / 13px line-height), padding `6.5px 10px`, `{rounded.none}`. Used for important categories like "GENERAL."

**`tag-muted`** — Gray secondary tag.
- Background transparent, text `rgba(255,255,255,0.5)`, same typography as `tag-accent`. Used for lower-priority labels like "NOTICE."

### Cards

**`card-event`** — Match schedule card.
- Background `#000000`, horizontal layout: date-left (20px / 700 number + 13px / 400 month in 50% white) + info-right (15px match name + 13px stage in 50% white + 13px time in `{colors.primary-deep}`). Element gap: 6px. All text `letter-spacing: -0.48px`.

**`card-media`** — Media content card.
- Vertical layout: thumbnail image top, category tag + title below. Title in white, tag in accent or muted color depending on importance.

### Buttons

**`button-primary`** — Base button.
- Transparent background, white text, `{typography.button-md}` (24px / 700 / -0.5px tracking), `{rounded.none}`. Hover shifts to `{colors.primary}`.

**`button-cta`** — CTA button (e.g., "PLAY NOW" in nav).
- Same as `button-primary` but at `{typography.body-sm}` scale. `{rounded.none}`, hover color shift.

### Footer

**`footer`** — Site footer.
- Background `#000000`, link text `#ffffff`, copyright text in lower opacity. Links arranged horizontally with separator characters. Hover: links shift to `{colors.primary}`.

### Link

**`link-inline`** — Inline link.
- Text `#ffffff`, `{typography.body-md}`, no underline. Hover: color shifts to `{colors.primary}` `#EFF923`. Transition: `all ease-in-out ~150ms`.

## Animation & Transition

- **Global transition**: `transition: all` applied to all elements with `ease-in-out` timing
- **Hover color shifts**: ~150ms, ease-in-out
- **Button hover**: ~200ms, ease-in-out
- **Card hover**: slight scale + color change, ~200ms, ease-out
- **Page load progress bar**: Nuxt.js progress bar, 2px height, fixed top, `#000000` background, z-index 999999

## Do's and Don'ts

### Do
- Use pure black `#000000` as every page/section background — no off-black, no dark gray canvas
- Build text hierarchy through **opacity levels** (100% / 50% / lower), not just font-size
- Reserve `{colors.primary}` (`#EFF923`) for hover states and key emphasis only — one neon accent per view
- Use `{colors.primary-deep}` (`#909615`) for functional information (match times, status labels)
- Keep `border-radius: 0` on every element — this is the #1 differentiating feature
- Apply `letter-spacing: -0.48px` globally on the body element
- Use `ease-in-out` / `ease-out` for all transitions — smooth but fast
- Stack spacing on 4px multiples

### Don't
- Don't use rounded corners anywhere — this is the most distinctive esports signal and breaking it collapses the identity
- Don't use `box-shadow` — the system is completely flat; contrast replaces depth
- Don't use gradient backgrounds — the brand's purity comes from solid black, not atmospheric gradients
- Don't introduce colors outside the yellow-green family (no blue, no red, no purple accents)
- Don't use serif fonts — sans-serif only for this aesthetic
- Don't set letter-spacing above `-0.48px` or positive — the tight tracking is the typographic signature
- Don't bump font-weight past 700 for body text — 900 is loaded but reserved for special moments
