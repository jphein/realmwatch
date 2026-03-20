# Design: Realm Map UI Overhaul — Dark Arcane Grimoire
**Date:** 2026-03-20
**Status:** Approved

## Goal

Transform the realm map from functional network monitor into a living grimoire — a treasure hoard of magical artifacts in ancient leather seals. Every surface gets the Dark Arcane treatment: weathered leather + purple base, treasure hoard palette (gold, emerald, amethyst, ruby, sapphire), AI-generated icons, upgraded panel modes with spectacle, and auto-detecting performance tiers.

**User directive:** "If in doubt go magical and beautiful."

---

## Design Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Art direction | Dark Arcane + Grimoire |
| Palette | Treasure hoard — gold, emerald, amethyst, ruby, sapphire, forest depths |
| Icon style | **Style B — Arcane Relics** (photorealistic 3D artifacts, green crystals, purple energy) |
| Seal housing | Weathered leather + purple, rotating runic ring, glint flash, aura pulse |
| Dock | **Enchanted Altar** — polished evolution of current, ley line + crown sigil |
| Wander mode | **Will-o-wisps** — gold/emerald/amethyst fireflies drifting through dark forest |
| Conjure mode | **Summoning circle** — ley lines, orbiting gem runes, central sigil |
| Anchored mode | Keep as-is |
| Performance | 3 auto-detected tiers via frame budget probe |

---

## 1. Global Palette & Theme

### 1a. Color System

Replace the current purple-only scheme with the treasure hoard palette. Each panel maps to a gem color for its seal, glow, and accent.

```
Gem Colors (primary):
  Gold     #f0d080 / #6b4c1a    (vitals, legend, census)
  Emerald  #80e8a0 / #1a4a2d    (quest log, energy)
  Amethyst #d0a0ff / #3a1a5e    (spellbook, debug, codex)
  Ruby     #ff9090 / #5a1a1a    (realm wards, vitals heartbeat)
  Sapphire #90c8ff / #1a3a5e    (cartographer, latency)
  Teal     #70e8d8 / #104840    (energy crystal)
  Amber    #f0c060 / #5a3a10    (codex, grimoire)
  Mint     #80f0c8 / #184838    (oracle commune)
  Indigo   #a0a8ff / #1a1a5e    (aether towers / wifi)
  Frost    #b0e0ff / #1a3850    (scrying terminal)

Surface Colors:
  Void         #0a0510          (deepest background)
  Forest Depth #060410          (dock/panel backgrounds)
  Leather      rgba(95,68,35)   (seal base — blended with purple)
  Arcane       rgba(85,55,70)   (leather + purple blend)
  Gold Rim     rgba(200,170,90) (borders, ley lines, accents)
```

### 1b. Typography

- **Headings:** Cinzel (serif) — panel titles, dock labels, section headers
- **Body:** Inter (sans-serif) — data values, descriptions (already in use)
- Load Cinzel via Google Fonts or self-host woff2

### 1c. Surface Treatment

All panels, dock, spellbook, and overlays get the weathered grimoire surface:

```css
/* Grimoire surface — reusable base */
.grimoire-surface {
  background:
    /* Fine grain texture (inline SVG noise) */
    url("data:image/svg+xml,...grain-pattern..."),
    /* Leather + purple radial */
    radial-gradient(ellipse at 30% 25%,
      rgba(85,55,70,0.95),
      rgba(60,38,55,0.97) 30%,
      rgba(42,25,42,0.98) 60%,
      rgba(28,16,30,0.99));
  border: 1px solid rgba(200,170,90,0.12);
  box-shadow:
    0 3px 12px rgba(15,8,20,0.7),
    inset 0 2px 1px rgba(200,170,110,0.1),
    inset 0 -3px 2px rgba(8,4,12,0.5);
}
```

Apply to: `.panel`, `.sealed-dock`, `#spellbook`, `.quest-log`, `.codex`, tooltips, dialogs, context menus.

---

## 2. Icon System

### 2a. Nova Canvas Icons (Style B)

Extend `generate-icons.py` to produce all 15 panel icons in Style B (Arcane Relics). Current 5 already generated; add remaining 10.

**Panel icon mapping:**

| Panel | Prompt concept | Gem color |
|-------|---------------|-----------|
| realm-panel (Vitals) | Cracked heart stone with green energy | Ruby |
| legend | Golden compass artifact with emerald inlay | Gold |
| spellbook | Crystal on ancient tome, purple aura | Amethyst |
| realm-codex (Codex) | Ornate scroll case with amber seal | Amber |
| quest-log | Scrolls with emerald crystal + quill | Emerald |
| cartographer | Astrolabe with sapphire lens | Sapphire |
| energy-panel | Green/purple crystal cluster on pedestal | Teal |
| node-list (Census) | Golden hourglass with flowing sand | Gold |
| debug-panel (Arcane Mirror) | Scrying orb with swirling purple mist | Amethyst |
| latency-panel (Arcane Pulse) | Sapphire tuning fork vibrating with energy | Sapphire |
| firewall-panel (Realm Wards) | Enchanted shield with emerald core | Ruby |
| wifi-panel (Aether Towers) | Crystal antenna tower with indigo lightning | Indigo |
| node-chat-dialog (Oracle) | Mint crystal ball on speaking pedestal | Mint |
| arcane-grimoire | Ancient book with golden star bookmark | Amber |
| scrying-terminal | Frost crystal lens mounted in brass | Frost |

**Output:** 512x512 PNG, stored in `assets/icons/style-b/`. Served via map_server.py static handler.

### 2b. Icon Rendering (3-mode system)

Extend `_setRuneIcon()` to support 3 modes (currently 2):

- **Mode 1:** SVG sigils (existing, default fallback)
- **Mode 2:** Emoji (existing)
- **Mode 3:** Nova Canvas PNGs (new) — `<img>` element inside `.rune-icon`

CSS for `.rune-icon img`: `width: 100%; height: 100%; border-radius: 50%; object-fit: cover; opacity: 0.8; filter: saturate(0.75) brightness(0.85);` — brightens on hover.

Note: Use safe DOM creation (`document.createElement`) for img elements, not string interpolation.

### 2c. Spellbook "Reforge" Button

Add button to Enchant tab. Calls `POST /icons/reforge` which runs `generate-icons.py` server-side. Progress via SSE. Low priority — manual script is fine for v1.

---

## 3. Seal Housing

### 3a. Weathered Seal Design

Replace current `.sealed-rune` styling with the brainstormed weathered leather + purple seal:

**Layers (inside to outside):**
1. **Nova Canvas icon** (img, 80% opacity, desaturated at rest)
2. **Inner glow** (radial gradient of `--accent-glow`, 15% opacity, 50% on hover)
3. **Carved runic ring** (conic-gradient notches, slow rotation 22s)
4. **Glint flash** (6s intermittent sparkle, staggered per rune)
5. **Outer aura** (1px border, 5s pulse)

**Resting state:** Dark, muted — icons barely visible through leather. Subtle glint catches the eye.
**Hover state:** Seal "awakens" — icon brightens, inner glow blooms, border glows with `--accent-glow`, slight scale(1.08) + translateY(-3px).

**CSS custom properties per rune:**
```css
--accent: #e07070;
--accent-glow: rgba(220,80,80,0.25);
```

Map from existing `_RUNE_COLORS` to new `--accent` / `--accent-glow` pairs.

### 3b. Seal Sizes

| Context | Size | Icon scale |
|---------|------|------------|
| Dock | 52px | 0.65x |
| Anchored | 56px | 0.7x |
| Wander (wisp) | 28-36px | 0.5x |
| Conjure (orbit) | 48px | 0.6x |
| Spellbook button | 32px | 0.45x |

---

## 4. Dock — Enchanted Altar

### 4a. Visual Upgrade

The dock shelf gets the grimoire surface treatment:

- **Background:** Weathered leather+purple radial gradient (rising from bottom)
- **Top edge:** Golden ley line (1px gradient, animated glow 4s)
- **Crown sigil:** Unicode star centered above ley line, pulsing 5s
- **Corner ornaments:** Keep existing, restyle to gold filigree

### 4b. Functional Changes

- **Rune gap:** 10px (down from 16px to fit more)
- **Dock height:** ~90px (unchanged, but visually richer)
- **Hover interaction:** Rune awakens (seal brightens), embers still fire on hover
- **Drag reorder:** Keep existing pointer-based system, restyle ghost + placeholder

### 4c. HUD Integration

HUD bar (level, XP, gold, gems) already positioned above dock. Restyle with grimoire surface + gold accents. No structural changes.

---

## 5. Panel Modes

### 5a. Dock Mode (Enchanted Altar)

Polish of existing. Changes:
- Grimoire surface on dock bar
- New seal styling (section 3)
- Ley line + crown sigil
- Staggered glint animations across runes

### 5b. Anchored Mode

Keep existing behavior (compass anchors, draggable, snap). Changes:
- New seal styling
- Anchor overlay markers restyle: gold rune on grimoire circles instead of plain dots

### 5c. Wander Mode — Will-o-Wisps

**Major rework.** Replace current velocity physics with wisp behavior:

**Visual:**
- Rune shrinks to 28-36px (smaller = more ethereal)
- Outer glow radius 2x rune size (soft color halo)
- Trail particles: 3-5 fading dots behind movement direction
- Glow color matches `--accent` (gold, emerald, amethyst per rune)

**Physics:**
- Replace linear velocity with **Brownian motion + attractor drift**
- Wisps gently wander toward random attractor points (change every 5-10s)
- Soft acceleration, no hard bounce — ease away from edges
- Speed: 0.3-0.8 px/frame (slower than current 1.5 max)

**Perf tiers:**
| Effect | High | Medium | Low |
|--------|------|--------|-----|
| Trail particles | Canvas (5 dots) | CSS box-shadow (2 dots) | None |
| Outer glow | Animated radius pulse | Static glow | Border only |
| Movement | Smooth RAF | 15fps throttle | CSS transition snap |

### 5d. Conjure Mode — Summoning Circle

**Major rework.** Replace current simple orbit with summoning ritual:

**Entry animation:** Runes converge from screen edges to center with particle burst.

**Central sigil:** Larger SVG (140px):
- Outer ring: 1px gold, slow clockwise rotation (20s)
- Inner ring: 1px amethyst, counter-clockwise (15s)
- 6 ley lines radiating from center (60deg apart), gradient gold to green to transparent
- Center: star sigil, pulsing scale 4s

**Orbit:**
- Keep existing orbit math (`_conjureAngle += 0.003`)
- Add orbit trail ring: decorative SVG circle at orbit radius
- Runes at 48px in full seal styling
- Wobble: keep existing `sin(_conjureAngle * 3 + i * 1.7) * 4`

**Perf tiers:**
| Effect | High | Medium | Low |
|--------|------|--------|-----|
| Ley lines | Animated + energy pulse | Static gradient | Hidden |
| Central sigil | Rotating rings + pulse | Rings only | Static ring |
| Orbit trail | Canvas particle comet | CSS glow trail | None |
| Entry animation | Converge + burst | Scale-in | Instant |

---

## 6. Panel Chrome

### 6a. Panel Headers

- Background: grimoire surface (leather+purple)
- Title: Cinzel font, gold color (#d4a574)
- Seal button: gold rim, amethyst interior glow
- Close/minimize buttons: gold on hover

### 6b. Panel Bodies

- Background: rgba(15,10,25,0.85) (deep void with slight transparency)
- Borders: 1px solid rgba(200,170,90,0.08)
- Scrollbars: thin, gold track

### 6c. Panel Transitions

- **Open (unseal):** Scale 0 to 1 + fade, 400ms cubic-bezier overshoot
- **Close (seal):** Scale 1 to 0 + fade, 300ms
- High tier: Add particle burst on unseal (ember scatter from rune position)

---

## 7. Spellbook Restyling

- Surface: grimoire treatment
- Tab labels: Cinzel font, gold active state
- Enchant tab seal mode buttons: show mini seal preview (new weathered seal at 28px)
- Toggle switches: gold knob, leather track
- Sliders: gold thumb, gold track line

---

## 8. Effects & Atmosphere

### 8a. Ambient Motes

Keep existing canvas particle system. Adjust palette:
- Replace 5-color sparkle set with treasure hoard: [gold, emerald, amethyst, ruby, sapphire]
- Node aura sparkles: use panel's `--accent` color
- Ley line sparkles: gold primary, with connection-type tint

### 8b. Connection Traffic

- Keep existing dash animation system
- Restyle: gold/amber for high traffic, emerald for moderate, sapphire for low
- Top-N glow filter: gold outer glow instead of current blue

### 8c. Loading Screen

If applicable, restyle with grimoire surface, treasure hoard loading bar, Cinzel titles.

---

## 9. Performance System

### 9a. Auto-Detection

Keep existing frame budget probe (effects.js). Extend:
- Probe for 5s instead of 10s (faster classification)
- Threshold: less than 25fps = low, 25-45fps = medium, over 45fps = high
- Store detected tier in localStorage (skip re-probe on reload)

### 9b. Tier Definitions

Extend `_PERF` in config.js with new properties:

```javascript
// New properties per tier:
sealGlint, sealRingRotate, wispTrail, conjureParticles,
transitionParticles, dockLeyline, runeBreath
```

- **Low:** No glint, no ring rotation, no trails, static ley line, no breath
- **Medium:** Glint + ring rotation, CSS trails, animated ley line, breath
- **High:** All of medium + canvas trails, conjure particles, transition particles, ley line particles

### 9c. Graceful Degradation

- `body.perf-low` / `body.perf-medium` / `body.perf-high` classes
- CSS uses these to toggle animations
- JS checks `_PERF.*` flags before spawning canvas particles

---

## 10. Asset Pipeline

### 10a. Directory Structure

```
assets/
  icons/
    style-b/
      realm-panel.png
      spellbook.png
      quest-log.png
      ... (15 total)
  fonts/
    cinzel-400.woff2
    cinzel-600.woff2
```

### 10b. Serving

`map_server.py` already serves static files with gzip + ETag. Add `image/png` to content-type mapping if missing. No build step needed — PNGs served directly.

### 10c. Icon Generation

- `generate-icons.py` extended with full 15-panel prompt set
- Run manually: `python3 generate-icons.py`
- Output to `assets/icons/style-b/`
- Future: `POST /icons/reforge` endpoint in map_server.py

---

## 11. Files to Modify

| File | Changes |
|------|---------|
| `realm-map.css` | Global palette vars, grimoire surface, seal restyle, dock restyle, panel chrome, perf classes, wander/conjure animations |
| `src/panel-manager.js` | Seal housing DOM (add ring/glint/aura layers), icon mode 3 (nova), wander wisp physics, conjure summoning circle, perf-aware animation toggling |
| `src/effects.js` | Treasure hoard sparkle palette, wisp trail particles, conjure entry burst, seal/unseal particle effects |
| `src/config.js` | Extended PERF_TIERS with new properties |
| `src/spellbook.js` | Restyle controls, icon mode selector, reforge button |
| `src/terrain.js` | Sparkle palette update |
| `src/traffic.js` | Connection color remap (gold/emerald/sapphire) |
| `realm-map.html` | Cinzel font link, asset preloads |
| `generate-icons.py` | Extend to 15 panels |
| `map_server.py` | PNG content-type (if needed), optional /icons/reforge endpoint |

---

## 12. What Stays the Same

- Map topology rendering (nodes, connections, regions)
- Panel content (firewall rules, quest log entries, codex, etc.)
- Backend (map_server.py endpoints, daemons, SSE)
- Anchored mode behavior
- Dock drag-to-reorder system
- Formation presets (scrying focus, warden's watch, etc.)
- HUD structure (level, XP, gold, gems)
- Mobile responsive layout
- Build pipeline (esbuild src/main.js to realm-map.js)

---

## Brainstorm Artifacts

All visual mockups in `.superpowers/brainstorm/1197704-1774038472/`:
- `recommendation.html` — final recommendation page (Style B + Altar)
- `full-vision.html` — palette, three modes, perf tier table
- `icon-styles.html` — 3 icon styles with Nova Canvas images in seals
- `dock-directions.html` — 3 dock layouts (Altar, Grimoire Tabs, Ribbon)
- `sigils-in-gems.html` — SVG sigils inside colored gem runes
- `sigils-weathered.html` — weathered seals with inner-glow sigils
- `sigils-balanced.html` — brighter variant of weathered seals
- `icons/style-b/` — approved icon set (5 of 15 generated)
