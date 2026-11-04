# WattWatch design plan

Subject: a live mains-circuit monitor for one home — a plug node feeding a
hub PC, read at a glance by a homeowner checking "is something wrong right
now" and shown once, on camera, in a hackathon demo. The vernacular is
household electrical hardware: breaker panels, panel schedules, utility
meters, multimeters — not a generic SaaS ops dashboard.

## Pass 1 — plan

### Color (dark, default)

| Token | Hex | Job |
|---|---|---|
| `bg` | `#17161A` | App background — neutral charcoal, not pure black, no hue riding toward one accent |
| `surface` | `#1E1C21` | Cards, sidebar, table rows |
| `surface-raised` | `#262329` | Drawer, dialog, hovered row |
| `border` | `#322E36` | Hairlines, card edges |
| `text` | `#EDEAF0` | Primary text |
| `text-muted` | `#9A94A3` | Secondary text, labels |
| `trace` (accent 1) | `#39D9B0` | "This is happening right now" — live dot, live wattage, chart line for current draw |
| `copper` (accent 2) | `#CC8B3C` | Stored/accumulated quantity — kWh and cost, the 7-day bars, the copper-wire association |
| `info` | `#5B9BD5` | Info severity, ML/anomaly tag |
| `warning` | `#E3A712` | Warning severity, hazard-amber |
| `critical` | `#E0503E` | Critical severity, hazard-red |

Light theme swaps the base, keeps every accent's *role*, darkened for AA
contrast on white: `bg #F4F5F3`, `surface #FFFFFF`, `border #DEDCE2`,
`text #1B1920`, `text-muted #68636F`, `trace #0E9C7D`, `copper #A6672A`,
`info #2E6FA8`, `warning #92650A`, `critical #B23A2B`.

Two accents, not one — `trace` marks what is live, `copper` marks what has
accumulated. They never swap jobs. Severity colors are functional (status),
never decorative.

### Type

One family, two roles, self-hosted via `@fontsource/ibm-plex-sans` and
`@fontsource/ibm-plex-mono`. IBM Plex was drawn for technical/instrument
contexts (IBM's own hardware and lab documentation), which fits a panel of
breakers better than a geometric startup grotesk.

- **Plex Sans** (400 body / 500 labels / 600 headings) — UI chrome, nav,
  copy, table headers.
- **Plex Mono** (400 secondary / 500 tabular-nums) — every metered value:
  watts, kWh, $, timestamps, device ids. Fixed-width digits so a live number
  doesn't jitter the layout as it ticks. This is the one deliberate
  "monospace" move, and it is load-bearing (real metering, not a label tic).

Scale: 13 small / 14 body / 16 lead / 20 section / 28 hero, 1.0 tracking
throughout (no tracked-out caps).

### Layout

Left sidebar, icon + label, 220px, collapsing to a 5-item bottom tab bar
under 768px (per plan). Content is left-aligned, max content width ~1120px,
8px spacing grid. No centered marketing-style hero — this is an instrument
panel, consulted, not read top to bottom.

**Overview** — the hero is the live number, not a stat-card grid:

```
┌ sidebar ┬──────────────────────────────────────────────────┐
│ WattWatch│  Overview                    ● Live   ⚑2   ☾    │
│──────────├──────────────────────────────────────────────────┤
│ Overview │ ┌─ live draw ──────────────────────────────────┐ │
│ Devices  │ │ 1,284 W                 ╱╲_╱╲___╱╲_╱╲        │ │
│ Alerts   │ │ across 3 devices        (graticule grid bg)  │ │
│ Topology │ └────────────────────────────────────────────────┘ │
│ Detection│ ┌ kWh today ┐┌ cost today ┐┌ open alerts ┐      │
│ Settings │ │ 4.82 kWh  ││   $0.72    ││      2       │      │
│          │ └───────────┘└────────────┘└──────────────┘      │
│          │ ┌─ power, last [10m 1h 24h] ─────────────────┐  │
│          │ │ stacked area, one line per device            │  │
│          │ └────────────────────────────────────────────────┘ │
│          │ ┌ recent alerts ────┐ ┌ devices ─────────────┐   │
│          │ │ 5 rows             │ │ 3 device cards        │   │
│          │ └────────────────────┘ └───────────────────────┘   │
│          │ ┌─ 7-day energy (copper bars) ───────────────────┐ │
│          └──────────────────────────────────────────────────┘ │
```

The live-draw panel is where boldness is spent: the number sits on a faint
oscilloscope-graticule grid with a short animated trace line behind it,
`trace`-colored. Everywhere else stays quiet and flat.

**Topology** — a panel schedule, not a flowchart. Sharp-cornered rectangles,
no drop shadow, a left status bar instead of a glow, right-angle (step)
connectors like ductwork/wiring, not curved flowchart edges:

```
                 ┌───────────┐
                 │▐ Hub PC   │
                 └─────┬─────┘
          ┌────────────┴────────────┐
      ┌───┴───────┐           ┌───┴───────┐
      │▐ ww-01     │           │▐ ww-02    │
      └───┬───────┘           └─────┬─────┘
    ┌──────┴──────┐                 │
┌───┴───┐    ┌───┴───┐         ┌───┴───┐
│▐ ch0  │    │▐ ch1  │         │▐ ch0  │
└───┬───┘    └───┬───┘         └───┬───┘
┌───┴───────┐┌───┴───────┐   ┌────┴──────┐
│▐ Kettle   ││▐ Heater   │   │▐ Fridge   │
│  1,480 W  ││     0 W   │   │  offline  │
└───────────┘└───────────┘   └───────────┘
```

`▐` = the left status bar (trace green online / muted grey unknown / critical
red offline), not a glow or badge.

### Principles

1. **Instrumentation, not decoration.** Numbers read like a meter: tabular
   mono digits, a signal trace instead of a gradient blob, status by
   color + shape together, never color alone.
2. **Two accents with fixed jobs.** `trace` = live/now. `copper` =
   accumulated/cost. A reader learns this once and it holds on every page.
3. **The panel schedule is the shape of the hardware.** Topology is drawn as
   breaker-panel rectangles with right-angle traces because the real thing
   is a panel feeding ports feeding plugs — not because flowcharts are the
   React Flow default.
4. **Quiet chrome.** No gradients, no soft drop-shadow-on-everything; a 1px
   border and the 8px grid carry structure. Card radius is small (6px) and
   reserved for dashboard tiles; topology nodes stay sharp-cornered on
   purpose, to read as hardware rather than UI.
5. **Severity is legible without color.** Every severity tag carries an
   icon and a word, so info/warning/critical survive grayscale and
   colorblindness, not just hue.

## Pass 2 — review against the brief

- Checked against the "near-black + one bright accent" default: rejected a
  literal near-black background in favor of a neutral charcoal with no hue
  riding toward the accent, and split one accent into two with distinct,
  fixed jobs (live vs. accumulated) rather than one decorative color. This
  is the main thing I changed after the first pass — my first draft used
  `#0B0F0D` (green-tinted near-black) and a single teal accent, which is
  exactly the warned-against pattern; I flattened the background's hue and
  gave copper real semantic work instead of leaving it a highlight.
- Checked the SaaS-card-kit default: topology nodes do **not** get the same
  rounded-card treatment as dashboard tiles. Sharp corners + left status bar
  there, small radius + hairline border on dashboard cards, no shared
  drop-shadow recipe across the two.
- Checked monospace-for-labels (a listed generated-page tell): mono is used
  only for metered values with tabular-nums, never for nav labels, section
  headers, or buttons — it is doing a real job (fixed-width live digits),
  not standing in as a generic "data" signifier.
- Checked copy rules up front: sentence case everywhere, no ALL-CAPS
  eyebrows, no "→" in button text, CTAs in active voice ("Save changes",
  not "Submit"), empty states phrased as what will appear and why it's
  empty, not just "No data."
- Kept fixed by the plan and not renegotiated: every route, every
  `data-testid`, the API contract, dark-default + light toggle, 390px
  responsiveness with a bottom tab bar, and the three severity levels
  (recolored, but still three, still always labeled).

## Pass 3 — v2 density (2026-11-03)

v1 proved the instrument-panel idea on one route. v2 has nine more pages,
telemetry down to the sample level, a tuned model and three AI surfaces —
the brief now is "Sense/Emporia/Particle-console tier," which means more
*shown*, not more decoration. Every addition below is read against the
Pass-1 principles before it's used: if a density move reintroduces a
SaaS-card-kit default (identical rounded tiles, one shadow recipe, a
gradient for texture) it's rejected the same way the first pass rejected
near-black-plus-one-accent.

**Boldness budget, spent twice, nowhere else.** The brief says "spend
boldness on Home and Live; keep everything else disciplined," which is
Pass-1's rule 1 applied at the page level instead of the element level.
Home keeps the graticule hero but the trace line is now a real 60s buffer
off the shared SSE connection, not a one-shot fetch; the "always on / active"
split renders as two adjacent labelled segments (a tiny stacked bar), never
a middle-dot string. Live is the demo page: full-bleed per-device wattage,
a scrolling 5-minute strip chart, and a flash-in event ticker are the one
place motion is allowed to run continuously (gated by
`prefers-reduced-motion`), because the whole page's job is "watch something
happen in real time." Nodes, Analytics, System and Settings stay flat,
tabular, hairline-bordered — information density through more *rows and
columns*, not bigger type or brighter color.

**Density tokens** (additive to Pass 1's palette/type scale, same vars file):

| Token | Value | Job |
|---|---|---|
| `--density-row-h` | `36px` | Compact table row height (nodes, audit, candidates, breakdown) — tighter than a dashboard card row so a 7×24 heatmap or a 20-row telemetry table doesn't force scrolling at 800px tall. |
| `--density-row-h-cozy` | `44px` | Default table row height everywhere else (devices, alerts, rules) — unchanged from v1. |
| `font-size: 11px` | `text-[11px]` util | Third type step below `13px small`, for table cell numerals only (never labels or body) — lets a telemetry/audit table fit 12+ columns of mono digits without truncation. |
| `--sparkline-h` | `28px` | Inline sparkline height inside a table cell or compact stat row — half a `StatCard` sparkline, used in the node list and system ingest rate. |
| `--chip-gap` | `6px` | Gap between stacked status chips (confidence meter segments, detector chips, severity + "Rule + ML") so a dense row of badges reads as a set, not a wrapped mess. |

**Heatmap and score-histogram color**: both are sequential, not
categorical, so they borrow `copper` (accumulated/structural data) at five
opacity steps (12%, 28%, 46%, 66%, 100%) rather than introducing a new hue —
the "two accents, fixed jobs" rule (Pass 1, principle 2) extends to derived
visualizations: a heatmap of *energy* is a copper thing, a live score trace
is a `trace` thing, never swapped.

**Command palette, notification drawer, drawers in general**: sharp-ish
corners (4px, between the 6px dashboard-card radius and topology's 0px) so
chrome that *acts* (opens, filters, jumps) sits visually between "structural
hardware" and "soft content card." No backdrop blur — a flat `rgba(0,0,0,.5)`
scrim, consistent with "no gradients, no soft shadow-on-everything."

**Why density, not redesign**: the brief's complaint is "too simplistic,"
not "wrong direction" — Pass 1's base (instrumentation over decoration, two
fixed-job accents, quiet chrome) is exactly what a real IoT console needs
more *of*, not a replacement for. v2 is the same instrument panel with more
dials on it.
