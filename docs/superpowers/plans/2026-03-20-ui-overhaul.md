# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the realm map UI into a Dark Arcane Grimoire with treasure hoard palette, AI-generated icons, weathered leather seals, upgraded panel modes (will-o-wisp wander, summoning circle conjure), and auto-detecting performance tiers.

**Architecture:** Incremental reskin — each task produces a visible, testable change. CSS palette and surface treatment first (everything looks better immediately), then seal housing rework, then dock polish, then icon pipeline, then mode upgrades, then perf tiers. No backend changes required except optional static asset serving.

**Tech Stack:** CSS custom properties, esbuild (existing), Bedrock Nova Canvas (existing generate-icons.py), vanilla JS (no frameworks), canvas particles (existing effects.js)

**Spec:** `docs/superpowers/specs/2026-03-20-ui-overhaul-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `realm-map.css` | All styles (~4300 lines) | Modify: palette vars, grimoire surface, seal restyle, dock, panel chrome, mode animations, perf classes |
| `src/panel-manager.js` | Seal modes, dock, rune DOM | Modify: seal housing layers, icon mode 3, wander wisp physics, conjure summoning circle |
| `src/effects.js` | Canvas particles, FPS, perf detect | Modify: treasure hoard sparkle palette, wisp trails, conjure burst |
| `src/config.js` | Constants, perf tiers | Modify: extended PERF_TIERS |
| `src/spellbook.js` | Spellbook panel controls | Modify: restyle controls, icon mode selector |
| `src/terrain.js` | Biome terrain, sparkle settings | Modify: sparkle palette update |
| `src/traffic.js` | Connection animations | Modify: traffic color remap |
| `realm-map.html` | Frontend HTML | Modify: font link, asset preloads |
| `generate-icons.py` | Nova Canvas icon generation | Modify: extend to 15 panels |
| `assets/icons/style-b/` | Generated icon PNGs | Create: directory + 15 PNGs |
| `map_server.py` | HTTP server | Verify: PNG content-type mapping for `/assets/` |

---

## Task 1: CSS Custom Properties — Treasure Hoard Palette

**Files:**
- Modify: `realm-map.css` (top of file, add `:root` block)
- Modify: `realm-map.html` (add Cinzel font link)

This task establishes the color system everything else builds on. No visual change yet — just the variables.

- [ ] **Step 1: Add Cinzel font to HTML**

In `realm-map.html`, add to `<head>`:
```html
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Add CSS custom properties**

At top of `realm-map.css`, add `:root` block with all palette colors:
```css
:root {
  /* Treasure Hoard Gems */
  --gem-gold: #f0d080;
  --gem-gold-deep: #6b4c1a;
  --gem-emerald: #80e8a0;
  --gem-emerald-deep: #1a4a2d;
  --gem-amethyst: #d0a0ff;
  --gem-amethyst-deep: #3a1a5e;
  --gem-ruby: #ff9090;
  --gem-ruby-deep: #5a1a1a;
  --gem-sapphire: #90c8ff;
  --gem-sapphire-deep: #1a3a5e;
  --gem-teal: #70e8d8;
  --gem-teal-deep: #104840;
  --gem-amber: #f0c060;
  --gem-amber-deep: #5a3a10;
  --gem-mint: #80f0c8;
  --gem-mint-deep: #184838;
  --gem-indigo: #a0a8ff;
  --gem-indigo-deep: #1a1a5e;
  --gem-frost: #b0e0ff;
  --gem-frost-deep: #1a3850;

  /* Surfaces */
  --void: #0a0510;
  --forest-depth: #060410;
  --leather: rgba(95,68,35,0.95);
  --arcane: rgba(85,55,70,0.95);
  --gold-rim: rgba(200,170,90,1);
  --gold-rim-dim: rgba(200,170,90,0.12);
  --gold-rim-bright: rgba(200,170,90,0.45);

  /* Typography */
  --font-heading: 'Cinzel', serif;
  --font-body: 'Inter', -apple-system, sans-serif;
  --text-gold: #d4a574;
  --text-leather: #b8a898;
  --text-dim: rgba(200,180,150,0.5);
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Open realm-map.html in browser — should look identical (vars defined but not yet used).

- [ ] **Step 4: Commit**

```bash
git add realm-map.css realm-map.html
git commit -m "feat: add treasure hoard CSS palette + Cinzel font"
```

---

## Task 2: Grimoire Surface — Panels & Dock

**Files:**
- Modify: `realm-map.css` (panel styles, dock styles, spellbook styles)

Apply the grimoire surface treatment to all major containers. This is the single biggest visual impact task.

- [ ] **Step 1: Create grimoire surface utility class**

Add after the `:root` block:
```css
/* Grimoire surface — reusable base */
.grimoire-surface,
.panel,
.sealed-dock,
#spellbook,
.quest-log-body,
.codex-body {
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Ccircle cx='1' cy='1' r='0.6' fill='rgba(180,160,120,0.03)'/%3E%3Ccircle cx='5' cy='3' r='0.4' fill='rgba(140,120,80,0.025)'/%3E%3Ccircle cx='3' cy='6' r='0.5' fill='rgba(100,70,140,0.02)'/%3E%3C/svg%3E"),
    radial-gradient(ellipse at 30% 25%,
      rgba(85,55,70,0.95),
      rgba(60,38,55,0.97) 30%,
      rgba(42,25,42,0.98) 60%,
      rgba(28,16,30,0.99));
}
```

- [ ] **Step 2: Restyle panel headers with Cinzel + gold**

Find `.panel-header` styles and update:
- `font-family: var(--font-heading);`
- `color: var(--text-gold);`
- Border bottom: `1px solid var(--gold-rim-dim);`

- [ ] **Step 3: Restyle panel bodies**

Find `.panel-body` / panel content styles:
- `background: rgba(15,10,25,0.85);`
- `border: 1px solid rgba(200,170,90,0.08);`

- [ ] **Step 4: Restyle panel seal button**

Find `.panel-seal-btn` and update to gold rim + amethyst glow:
- `border: 1px solid rgba(200,170,90,0.3);`
- `color: var(--text-gold);`
- Hover: `box-shadow: 0 0 12px rgba(200,170,90,0.3);`

- [ ] **Step 5: Restyle dock bar**

Find `.sealed-dock` background and replace with grimoire surface + ley line:
- Background: leather+purple radial
- `::before` (ley line): gold gradient `linear-gradient(90deg, transparent, rgba(200,170,90,0.2) 20%, rgba(230,200,110,0.35) 50%, ...)`
- `::after` (crown): `color: rgba(200,170,90,0.35);`
- Reduce `.dock-tray` gap from 16px to 10px (spec 4b)

- [ ] **Step 6: Restyle HUD bar**

Find `.dock-hud` styles and apply grimoire surface + gold accents:
- Background: grimoire surface (leather+purple)
- Level circle: gold border, Cinzel font
- XP bar: gold track, emerald fill
- Gold/gem counters: `color: var(--text-gold); font-family: var(--font-heading);`

- [ ] **Step 7: Restyle spellbook**

Find `#spellbook` styles:
- Apply grimoire surface
- Tab labels: `font-family: var(--font-heading); color: var(--text-gold);`
- Active tab: brighter gold border-bottom

- [ ] **Step 8: Build and visual check**

Run: `npm run build`
Check: panels, dock, spellbook, HUD should have dark leather+purple surface with gold accents.

- [ ] **Step 9: Commit**

```bash
git add realm-map.css
git commit -m "feat: apply grimoire surface to panels, dock, HUD, and spellbook"
```

---

## Task 3: Seal Housing Rework

**Files:**
- Modify: `realm-map.css` (`.sealed-rune` and related classes, lines ~5872-6936)
- Modify: `src/panel-manager.js` (rune DOM creation, `_RUNE_COLORS` map)

Replace current rune styling with weathered leather + purple seal housing with layered effects.

- [ ] **Step 1: Update `_RUNE_COLORS` to accent pairs**

In `src/panel-manager.js`, find `_RUNE_COLORS` map (around line 737) and extend each entry to include accent + glow values. Add a parallel `_RUNE_ACCENTS` map:

```javascript
const _RUNE_ACCENTS = {
  'realm-panel':    { accent: '#e07070', glow: 'rgba(220,80,80,0.25)' },
  'legend':         { accent: '#dcc060', glow: 'rgba(220,190,80,0.25)' },
  'spellbook':      { accent: '#b888e0', glow: 'rgba(160,100,220,0.25)' },
  'realm-codex':    { accent: '#d8b060', glow: 'rgba(210,170,80,0.25)' },
  'quest-log':      { accent: '#70c080', glow: 'rgba(80,200,120,0.2)' },
  'cartographer':   { accent: '#80b0e8', glow: 'rgba(100,160,230,0.25)' },
  'energy-panel':   { accent: '#60c8b8', glow: 'rgba(60,200,180,0.25)' },
  'node-list':      { accent: '#dcc060', glow: 'rgba(220,190,80,0.25)' },
  'debug-panel':    { accent: '#b888e0', glow: 'rgba(160,100,220,0.25)' },
  'latency-panel':  { accent: '#80b0e8', glow: 'rgba(100,160,230,0.25)' },
  'firewall-panel': { accent: '#e07070', glow: 'rgba(220,80,80,0.25)' },
  'wifi-panel':     { accent: '#8890d0', glow: 'rgba(100,100,200,0.25)' },
  'node-chat-dialog':{ accent: '#70c8a8', glow: 'rgba(80,200,160,0.25)' },
  'arcane-grimoire': { accent: '#d8b060', glow: 'rgba(210,170,80,0.25)' },
  'scrying-terminal':{ accent: '#80b8d8', glow: 'rgba(100,170,210,0.25)' },
};
```

- [ ] **Step 2: Update rune DOM creation**

In `_createRuneForPanel()`, after setting `--rune-color`, also set:
```javascript
const accents = _RUNE_ACCENTS[panel.id];
if (accents) {
  rune.style.setProperty('--accent', accents.accent);
  rune.style.setProperty('--accent-glow', accents.glow);
}
```

Add new child elements to the rune:
```javascript
// Inner glow
const innerGlow = document.createElement('div');
innerGlow.className = 'rune-inner-glow';
rune.appendChild(innerGlow);

// Carved ring (replace existing rune-ring SVG with conic-gradient div)
const carvedRing = document.createElement('div');
carvedRing.className = 'rune-carved-ring';
rune.appendChild(carvedRing);

// Glint
const glint = document.createElement('div');
glint.className = 'rune-glint-flash';
rune.appendChild(glint);

// Outer aura
const aura = document.createElement('div');
aura.className = 'rune-outer-aura';
rune.appendChild(aura);
```

- [ ] **Step 3: Restyle `.sealed-rune` base**

In `realm-map.css`, replace the `.sealed-rune` block with weathered leather+purple:

```css
.sealed-rune {
  --accent: #d4a574;
  --accent-glow: rgba(212,165,80,0.3);
  width: 52px;
  height: 52px;
  border-radius: 50%;
  position: relative;
  cursor: pointer;
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Ccircle cx='1' cy='1' r='0.6' fill='rgba(180,160,120,0.03)'/%3E%3Ccircle cx='5' cy='3' r='0.4' fill='rgba(140,120,80,0.025)'/%3E%3Ccircle cx='3' cy='6' r='0.5' fill='rgba(100,70,140,0.02)'/%3E%3C/svg%3E"),
    radial-gradient(ellipse at 30% 25%,
      rgba(85,55,70,0.95),
      rgba(60,38,55,0.97) 30%,
      rgba(42,25,42,0.98) 60%,
      rgba(28,16,30,0.99));
  border: 2px solid rgba(160,120,80,0.28);
  box-shadow:
    0 3px 12px rgba(15,8,20,0.7),
    0 0 20px rgba(80,40,60,0.1),
    inset 0 2px 1px rgba(200,170,110,0.1),
    inset 0 -3px 2px rgba(8,4,12,0.5);
  animation: rune-float 3s ease-in-out infinite;
  transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1),
              border-color 0.4s ease,
              box-shadow 0.4s ease;
}
.sealed-rune:hover {
  transform: translateY(-3px) scale(1.08);
  border-color: rgba(200,170,90,0.45);
  box-shadow:
    0 4px 16px rgba(15,8,20,0.8),
    0 0 28px var(--accent-glow),
    inset 0 2px 1px rgba(220,190,120,0.15),
    inset 0 -3px 2px rgba(8,4,12,0.5),
    inset 0 0 24px var(--accent-glow);
}
```

- [ ] **Step 4: Add new layer styles**

```css
.rune-inner-glow {
  position: absolute;
  inset: 6px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow), transparent 70%);
  opacity: 0.15;
  pointer-events: none;
  transition: opacity 0.5s ease;
}
.sealed-rune:hover .rune-inner-glow { opacity: 0.5; }

.rune-carved-ring {
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  border: 1px solid rgba(200,170,90,0.12);
  pointer-events: none;
  animation: ringRotate 22s linear infinite;
  background: conic-gradient(
    from 0deg,
    transparent 0deg, rgba(200,170,90,0.1) 4deg, transparent 8deg,
    transparent 60deg, rgba(200,170,90,0.1) 64deg, transparent 68deg,
    transparent 120deg, rgba(200,170,90,0.1) 124deg, transparent 128deg,
    transparent 180deg, rgba(200,170,90,0.1) 184deg, transparent 188deg,
    transparent 240deg, rgba(200,170,90,0.1) 244deg, transparent 248deg,
    transparent 300deg, rgba(200,170,90,0.1) 304deg, transparent 308deg,
    transparent 360deg
  );
}

.rune-glint-flash {
  position: absolute;
  top: 10px;
  left: 14px;
  width: 6px;
  height: 6px;
  background: radial-gradient(circle, rgba(255,240,180,0.9), transparent 60%);
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
  animation: glintFlash 6s ease-in-out infinite;
  z-index: 5;
}

.rune-outer-aura {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 1px solid rgba(160,120,80,0.06);
  pointer-events: none;
  animation: auraPulse 5s ease-in-out infinite;
}
.sealed-rune:hover .rune-outer-aura {
  border-color: var(--accent-glow);
  box-shadow: 0 0 14px var(--accent-glow);
}

@keyframes ringRotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes glintFlash {
  0%, 70%, 100% { opacity: 0; transform: scale(0.5); }
  75% { opacity: 1; transform: scale(1.6); }
  80% { opacity: 0.4; transform: scale(1); }
  85% { opacity: 0.8; transform: scale(1.4); }
  90% { opacity: 0; transform: scale(0.8); }
}
@keyframes auraPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }
```

- [ ] **Step 5: Stagger glint animations**

Add stagger rules so glints cascade across dock runes:
```css
.sealed-rune:nth-child(1) .rune-glint-flash { animation-delay: 0s; }
.sealed-rune:nth-child(2) .rune-glint-flash { animation-delay: -1s; }
.sealed-rune:nth-child(3) .rune-glint-flash { animation-delay: -2s; }
/* ... up to 8 */
.sealed-rune:nth-child(2) .rune-carved-ring { animation-direction: reverse; animation-duration: 28s; }
.sealed-rune:nth-child(3) .rune-carved-ring { animation-duration: 18s; }
```

- [ ] **Step 6: Build and visual check**

Run: `npm run build`
Check: sealed runes in dock should be weathered leather+purple with glinting ring, glow on hover.

- [ ] **Step 7: Commit**

```bash
git add realm-map.css src/panel-manager.js
git commit -m "feat: weathered leather seal housing with ring, glint, and aura layers"
```

---

## Task 4: Icon Pipeline — Generate All 15 & Serve

**Files:**
- Modify: `generate-icons.py` (extend panel list)
- Create: `assets/icons/style-b/` (directory + 15 PNGs)
- Modify: `src/panel-manager.js` (add icon mode 3)
- Modify: `src/spellbook.js` (add icon mode selector)
- Modify: `realm-map.css` (`.rune-icon img` styles)

- [ ] **Step 1: Create assets directory**

```bash
mkdir -p assets/icons/style-b
```

- [ ] **Step 2: Extend generate-icons.py with all 15 panels**

Read the existing script at `.superpowers/brainstorm/1197704-1774038472/generate-icons.py`. Copy to project root as `generate-icons.py`. Extend the PANELS list with all 15 entries using Style B prompts from the spec (section 2a).

Output path: `assets/icons/style-b/{panel-key}.png`

- [ ] **Step 3: Run icon generation**

```bash
python3 generate-icons.py
```

Verify: `ls assets/icons/style-b/` should show 15 PNG files.

- [ ] **Step 4: Copy existing 5 icons as fallback**

If generation fails for some panels, copy the existing 5 from brainstorm dir:
```bash
cp .superpowers/brainstorm/1197704-1774038472/icons/style-b/*.png assets/icons/style-b/
```

- [ ] **Step 5: Add icon mode 3 to panel-manager.js**

Find `_setRuneIcon()` and extend:
```javascript
// After existing emoji check, before SVG fallback:
if (_iconMode === 'nova') {
  iconEl.textContent = '';
  const img = document.createElement('img');
  img.src = '/assets/icons/style-b/' + panelId + '.png';
  img.alt = def.name;
  img.className = 'rune-icon-img';
  img.draggable = false;
  iconEl.appendChild(img);
  return;
}
```

Add `_iconMode` variable (default: `'nova'`), persist in localStorage `realm-icon-mode`.

- [ ] **Step 6: Add CSS for icon images**

In `realm-map.css`:
```css
.rune-icon-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  opacity: 0.8;
  filter: saturate(0.75) brightness(0.85);
  transition: opacity 0.4s ease, filter 0.4s ease;
  pointer-events: none;
}
.sealed-rune:hover .rune-icon-img {
  opacity: 1;
  filter: saturate(0.9) brightness(1.05);
}
```

- [ ] **Step 7: Add icon mode selector to spellbook Enchant tab**

In `src/spellbook.js`, find the Sealed Runes section. Add a 3-button row:
- "Sigils" (SVG), "Emoji", "Arcane Relics" (nova)
- Click handler: sets `_iconMode`, re-renders all rune icons, saves to localStorage.

- [ ] **Step 8: Verify server serves PNGs**

Check that `map_server.py` serves PNG files correctly. If the static file handler doesn't include `image/png` in content-type mapping, add it. Test:
```bash
curl -I http://localhost:8777/assets/icons/style-b/realm-panel.png
```
Expected: `Content-Type: image/png`, 200 OK.

- [ ] **Step 9: Build and verify**

Run: `npm run build`
Check: dock runes should show Style B images inside weathered seals. Switching modes in spellbook should swap between SVG/emoji/nova.

- [ ] **Step 10: Commit**

```bash
git add assets/icons/ generate-icons.py realm-map.css src/panel-manager.js src/spellbook.js
git commit -m "feat: Nova Canvas icon pipeline — 15 Arcane Relics icons with 3-mode selector"
```

---

## Task 5: Ambient Effects — Treasure Hoard Palette

**Files:**
- Modify: `src/effects.js` (sparkle color array)
- Modify: `src/terrain.js` (sparkle settings)
- Modify: `src/traffic.js` (traffic colors)

- [ ] **Step 1: Update sparkle palette in effects.js**

Find the 5-color sparkle array and replace with treasure hoard:
```javascript
const SPARKLE_COLORS = [
  [240, 208, 128],  // gold
  [128, 232, 160],  // emerald
  [208, 160, 255],  // amethyst
  [255, 144, 144],  // ruby
  [144, 200, 255],  // sapphire
];
```

- [ ] **Step 2: Update node aura colors**

Find node type color mapping and adjust to treasure hoard:
- Core: gold [240, 208, 128]
- Tower: sapphire [144, 200, 255]
- Default: emerald [128, 232, 160]

- [ ] **Step 3: Update traffic colors in traffic.js**

Find traffic intensity color logic and remap:
- High traffic: gold/amber tones
- Medium: emerald
- Low: sapphire
- Top-N glow: gold outer glow

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Check: ambient sparkles should shimmer in gold/emerald/amethyst. Traffic connections should glow gold.

- [ ] **Step 5: Commit**

```bash
git add src/effects.js src/terrain.js src/traffic.js
git commit -m "feat: treasure hoard palette for ambient sparkles and traffic"
```

---

## Task 6: Wander Mode — Will-o-Wisps

**Files:**
- Modify: `src/panel-manager.js` (`_sealWandering()`, `_animateWandering()`)
- Modify: `realm-map.css` (`.wandering-rune` styles)
- Modify: `src/effects.js` (wisp trail particles)

- [ ] **Step 1: Restyle wandering runes**

In `realm-map.css`, update `.wandering-rune`:
```css
.wandering-rune {
  width: 32px !important;
  height: 32px !important;
  box-shadow:
    0 0 20px var(--accent-glow),
    0 0 40px var(--accent-glow);
}
.wandering-rune .rune-icon { font-size: 14px; }
.wandering-rune .rune-icon-img { opacity: 0.6; filter: saturate(0.5) brightness(0.7); }
.wandering-rune .rune-carved-ring { display: none; }
.wandering-rune .rune-glint-flash { display: none; }
.wandering-rune .rune-outer-aura {
  inset: -8px;
  border: none;
  background: radial-gradient(circle, var(--accent-glow), transparent 70%);
  opacity: 0.4;
  animation: wispGlow 3s ease-in-out infinite;
}
@keyframes wispGlow {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.2); }
}
```

- [ ] **Step 2: Replace physics with Brownian motion**

In `src/panel-manager.js`, replace `_animateWandering()`:
- Each wisp gets a random attractor `{ ax, ay }` (random screen position)
- Every 5-10s, pick new attractor
- Acceleration toward attractor: `0.02 * (ax - x)`, clamped
- Damping: `vx *= 0.98` each frame
- Soft edge avoidance: if within 80px of edge, gentle push inward
- Speed: max 0.8 px/frame

- [ ] **Step 3: Add wisp trail particles**

In `src/effects.js`, add `spawnWispTrail(x, y, color)`:
- Spawns 1 particle per 3 frames behind wisp movement
- Particle: size 2-3px, color from `--accent`, life 0.5s, no velocity
- Only if `_PERF.wispTrail !== false`

Call from `_animateWandering()` each frame per wisp.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Switch to Wander mode in spellbook. Runes should shrink, glow, drift slowly with subtle trails.

- [ ] **Step 5: Commit**

```bash
git add src/panel-manager.js realm-map.css src/effects.js
git commit -m "feat: will-o-wisp wander mode — Brownian drift, glow halos, trail particles"
```

---

## Task 7: Conjure Mode — Summoning Circle

**Files:**
- Modify: `src/panel-manager.js` (`_createConjuredContainer()`, `_arrangeConjuredRunes()`, `_startConjureOrbit()`)
- Modify: `realm-map.css` (`.conjured-runes` styles)

- [ ] **Step 1: Redesign central sigil SVG**

In `_createConjuredContainer()`, replace the current sigil SVG with:
- Outer ring: 140px, 1px gold stroke, `animation: ringRotate 20s linear infinite`
- Inner ring: 100px, 1px amethyst stroke, reverse direction 15s
- 6 ley lines: `<line>` elements at 60deg intervals, gold-to-transparent gradient
- Center sigil: star character, pulsing scale

- [ ] **Step 2: Add orbit trail ring**

Add a decorative SVG circle at the orbit radius (`.conjure-orbit-ring`):
```css
.conjure-orbit-ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(200,170,90,0.08);
  animation: orbit-ring-pulse 6s ease-in-out infinite;
  pointer-events: none;
}
```

Size and position it dynamically based on `_arrangeConjuredRunes()` radius.

- [ ] **Step 3: Add entry animation**

When switching to conjure mode, runes start at their current screen positions and animate to orbit positions over 600ms with cubic-bezier overshoot. Add a particle burst at center when all runes arrive.

- [ ] **Step 4: Restyle conjured runes**

```css
.conjured-runes .sealed-rune {
  width: 48px;
  height: 48px;
}
```

Keep existing orbit math, update the central sigil CSS to use treasure hoard colors (gold rings, amethyst inner, green ley lines).

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Switch to Conjure mode. Should see gold/amethyst summoning circle with orbiting runes.

- [ ] **Step 6: Commit**

```bash
git add src/panel-manager.js realm-map.css
git commit -m "feat: summoning circle conjure mode — gold/amethyst rings, ley lines, orbit trail"
```

---

## Task 8: Performance Tiers — Graceful Degradation

**Files:**
- Modify: `src/config.js` (extend PERF_TIERS)
- Modify: `src/effects.js` (tier-aware spawning)
- Modify: `realm-map.css` (perf override classes)
- Modify: `src/panel-manager.js` (tier-aware seal animations)

- [ ] **Step 1: Extend PERF_TIERS in config.js**

Add new properties to each tier:
```javascript
// Add to each tier object:
low:    { ..., sealGlint: false, sealRingRotate: false, wispTrail: false, conjureParticles: false, transitionParticles: false, runeBreath: false, dockLeyline: 'static' },
medium: { ..., sealGlint: true,  sealRingRotate: true,  wispTrail: 'css',  conjureParticles: false, transitionParticles: false, runeBreath: true,  dockLeyline: 'animated' },
high:   { ..., sealGlint: true,  sealRingRotate: true,  wispTrail: 'canvas', conjureParticles: true, transitionParticles: true, runeBreath: true,  dockLeyline: 'animated' },
```

- [ ] **Step 2: Add CSS perf override classes**

```css
body.perf-low .rune-carved-ring { animation: none; }
body.perf-low .rune-glint-flash { display: none; }
body.perf-low .rune-outer-aura { animation: none; opacity: 0.3; }
body.perf-low .sealed-dock::before { animation: none; }
body.perf-low .wandering-rune .rune-outer-aura { animation: none; }
body.perf-low .conjure-orbit-ring { animation: none; }
body.perf-low .sealed-rune { animation: rune-float 3s ease-in-out infinite; } /* no breath */
```

- [ ] **Step 3: Apply body class on tier detection**

In `src/effects.js`, where `setPerfTier()` is called, also set:
```javascript
document.body.classList.remove('perf-low', 'perf-medium', 'perf-high');
document.body.classList.add('perf-' + tier);
```

- [ ] **Step 4: Reduce probe duration from 10s to 5s**

In `src/effects.js`, find the auto-detect probe duration constant (currently 10s) and change to 5s for faster classification. Threshold: <25fps = low, 25-45fps = medium, >45fps = high.

- [ ] **Step 5: Cache tier in localStorage**

Store detected tier: `localStorage.setItem('realm-perf-tier', tier)`.
On load, read cached tier and apply immediately (skip probe if cached).
Add "Reset" button in debug panel to clear cache and re-probe.

- [ ] **Step 5: Guard particle spawning**

In effects.js wisp trail: check `_PERF.wispTrail` before spawning.
In panel-manager.js conjure burst: check `_PERF.conjureParticles`.

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Test: manually set `localStorage.setItem('realm-perf-tier', 'low')` and reload — animations should be stripped. Set to 'high' — full effects.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/effects.js realm-map.css src/panel-manager.js
git commit -m "feat: 3-tier perf system with graceful degradation for seal effects"
```

---

## Task 9: Interactions — Transitions, Anchored Mode, Drag Restyle

**Files:**
- Modify: `realm-map.css` (panel transitions, anchored rune size, anchor markers, drag ghost)
- Modify: `src/panel-manager.js` (unseal particle burst trigger)
- Modify: `src/effects.js` (unseal particle burst function)

- [ ] **Step 1: Add panel open/close transitions**

In `realm-map.css`, add panel transition animations:
```css
@keyframes panelUnseal {
  from { transform: scale(0); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
@keyframes panelSeal {
  from { transform: scale(1); opacity: 1; }
  to { transform: scale(0); opacity: 0; }
}
.panel-unsealing {
  animation: panelUnseal 400ms cubic-bezier(0.34,1.56,0.64,1) forwards;
}
.panel-sealing {
  animation: panelSeal 300ms ease-in forwards;
}
```

- [ ] **Step 2: Add unseal particle burst**

In `src/effects.js`, add `spawnUnsealBurst(x, y, color)`:
- Spawns 15-20 particles radiating outward from (x, y)
- Uses the rune's `--accent` color
- Only if `_PERF.transitionParticles`

In `src/panel-manager.js`, call `spawnUnsealBurst()` when unsealing a panel (in `_unsealPanel()`), passing the rune's center position and accent color.

- [ ] **Step 3: Restyle anchored runes**

In `realm-map.css`, set anchored rune size to 56px (spec 3b):
```css
.anchored-rune {
  width: 56px !important;
  height: 56px !important;
}
```

- [ ] **Step 4: Restyle anchor overlay markers**

Find `.ley-anchor` / `.anchor-rune` styles and update:
- Background: grimoire surface (small circle)
- Rune symbol: gold color `var(--text-gold)`
- Active state: gold glow + scale

- [ ] **Step 5: Restyle drag ghost and placeholder**

Find `.dock-drag-ghost` and drag placeholder styles:
- Ghost: grimoire surface background, gold border, slight glow
- Placeholder: dashed gold border, `border-color: var(--gold-rim-dim);`

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Test: seal/unseal panels — should animate with scale transition. High perf tier: particle burst on unseal. Anchored runes: 56px. Drag reorder: restyled ghost.

- [ ] **Step 7: Commit**

```bash
git add realm-map.css src/panel-manager.js src/effects.js
git commit -m "feat: panel transitions, anchored restyle, unseal particle burst"
```

---

## Task 10: Final Polish — Tooltips, Scrollbars, Spellbook Controls, Loading

**Files:**
- Modify: `realm-map.css` (tooltips, scrollbars, spellbook controls, loading screen)
- Modify: `src/spellbook.js` (mini seal preview on mode buttons)

- [ ] **Step 1: Restyle tooltips**

Find tooltip styles and apply:
- Grimoire surface background
- Gold border: `1px solid var(--gold-rim-dim)`
- Text: `color: var(--text-leather);`
- Title/label: `font-family: var(--font-heading); color: var(--text-gold);`

- [ ] **Step 2: Restyle scrollbars**

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: rgba(15,10,25,0.5); }
::-webkit-scrollbar-thumb {
  background: rgba(200,170,90,0.2);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(200,170,90,0.35); }
```

- [ ] **Step 3: Restyle spellbook controls**

In `realm-map.css`:
- Toggle switches: gold knob (`background: var(--gem-gold);`), leather track
- Sliders (`input[type=range]`): gold thumb, thin gold track line
- Seal mode buttons in Enchant tab: add mini seal preview at 32px (spellbook button size per spec 3b)

In `src/spellbook.js`, update seal mode buttons to show a small weathered seal icon (32px) alongside the mode name, instead of plain emoji.

- [ ] **Step 4: Restyle loading screen**

Find loading/splash styles in `realm-map.css`:
- Apply grimoire surface to loading container
- Loading bar: gold fill track, emerald progress
- Title: `font-family: var(--font-heading); color: var(--text-gold);`

- [ ] **Step 5: Restyle context menus / dropdowns**

Apply grimoire surface + gold borders to any remaining unstyled overlays.

- [ ] **Step 6: Build and full visual sweep**

Run: `npm run build`
Full visual sweep — every surface should be grimoire-treated. Check: tooltips, scrollbars, spellbook controls, loading screen, context menus.

- [ ] **Step 7: Commit**

```bash
git add realm-map.css src/spellbook.js
git commit -m "feat: final grimoire polish — tooltips, scrollbars, spellbook controls, loading"
```

---

## Deferred

**Spec 2c: Spellbook "Reforge" Button** — Deferred to a future plan. The spec marks this as low priority ("manual script is fine for v1"). Would require a new `POST /icons/reforge` endpoint in `map_server.py` and spellbook UI. For now, run `python3 generate-icons.py` manually to regenerate icons.

---

## Summary

| Task | Description | Impact |
|------|-------------|--------|
| 1 | CSS palette + Cinzel font | Foundation (no visual change) |
| 2 | Grimoire surface on panels/dock/HUD/spellbook | Biggest visual impact |
| 3 | Seal housing rework | Dock runes transform |
| 4 | Icon pipeline + 15 Arcane Relics | Icons inside seals |
| 5 | Ambient effects palette | Sparkles/traffic recolor |
| 6 | Wander — will-o-wisps | New mode behavior |
| 7 | Conjure — summoning circle | New mode behavior |
| 8 | Performance tiers | Graceful degradation |
| 9 | Interactions — transitions, anchored, drag | Seal/unseal animation |
| 10 | Final polish — tooltips, controls, loading | Complete sweep |

Each task produces a buildable, visually testable result. Tasks 1-5 are the core transformation. Tasks 6-7 are mode upgrades. Tasks 8-10 are hardening and polish.
