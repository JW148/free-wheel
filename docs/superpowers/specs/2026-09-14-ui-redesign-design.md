# UI redesign — design

Written 2026-09-14. Source: the Claude Design handoff bundle (`Free Wheel Redesign - Final.dc.html`
turn 1, plus turns 2 and 3 of `Free Wheel Redesign.dc.html`).

The designs are prototypes in HTML/CSS/JS. They are a specification of *visual output*, not of
structure — we match what they draw and keep the architecture this repo already has, which
they cannot see: the OPFS handle registry, the one MapLibre instance, the region partition,
the ΔE clearance tests, the parity corpus.

## What this is

Three things at once, and it is worth naming them separately because only the first is a
restyle:

1. **A new design system.** The chrome moves from the dark slate ramp to light — `#f6f5f1`
   surfaces, `#12212b` ink, white cards, soft shadows. A dark variant is derived from the same
   tokens and driven by the existing day/night control.
2. **A simpler planning model.** Ticking profiles and pressing Compare is replaced by: tap
   start, tap finish, get three named routes. The six engine profiles survive behind *More
   riding styles*.
3. **A screen that does not exist.** A six-card first-run walkthrough, in pixel art drawn from
   the app icon.

## Decisions taken

Settled with the user before this was written:

| | Decision |
|---|---|
| Chrome | Light as designed, **plus** a dark variant from the same tokens, on the existing day/night control |
| Onboarding art | Design **3b** — pixel glyphs on a slate tile, light chrome. No photographs, no licensing, no bytes |
| Route compute | Three routes automatically on the second tap, with a distance guard above which only the default style runs |
| Delivery | One branch, staged commits, one PR |
| Map taps | The point-editing toggle goes. Taps place waypoints while planning; they already do nothing while riding |
| Setup | A settings list that pushes to *Maps on this phone* and *You and the bike*; Diagnostics is a footer link |
| Saved | A full-screen overlay, as design 1h draws it |

Excluded by the user: **the map-based region picker in designs 1i and 2c.** Those mockups draw
bounding boxes over a streamed map of Britain. The app paints a *partition* — fourteen
overlapping published boxes resolved against `REGION_SEEDS` and clipped to the coast by the
basemap's own water — which is better than what the design shows and was expensive to get
right. `regionShapes.ts`, `regionLayers.ts` and `BrowseMap.tsx` keep their behaviour and their
colours. Only the bottom sheet over them is redesigned, from 1i.

## The design system

### Tokens

Light is the primary. Dark is a re-mapping of the same names onto the existing slate ramp, so
nothing but the token block knows which is in force.

| Token | Light | Dark |
|---|---|---|
| `--page` | `#f6f5f1` | `#06141b` (`--slate-900`) |
| `--card` | `#ffffff` | `#11212d` (`--slate-800`) |
| `--inset` | `#f6f5f1` | `#253745` (`--slate-700`) |
| `--fill` | `#f1f0eb` | `rgb(37 55 69 / 55%)` |
| `--track` | `#e7e5de` | `#253745` |
| `--ink` | `#12212b` | `#ccd0cf` (`--slate-100`) |
| `--muted` | `#5c6b74` | `#9ba8ab` (`--slate-300`) |
| `--faint` | `#8a969d` | `#4a5c6a` (`--slate-500`) |
| `--hairline` | `rgb(18 33 43 / 8%)` | `rgb(204 208 207 / 12%)` |
| `--edge` | `rgb(18 33 43 / 12%)` | `rgb(204 208 207 / 18%)` |
| `--on-ink` | `#ffffff` | `#0f1e29` |
| `--good` / `--good-bg` | `#2d7a3a` / `#e9f0e9` | `#5a9e63` / `rgb(90 158 99 / 18%)` |
| `--bad` / `--bad-bg` | `#b23a2b` / `#fbe9e6` | `#c4707a` / `rgb(196 112 122 / 18%)` |

Floating surfaces over the map keep their translucency, restated per theme and — as today —
defined on `:root` rather than `.ride`, because vaul portals the drawer to `<body>`:

| Token | Light | Dark |
|---|---|---|
| `--panel` | `rgb(255 255 255 / 92%)` | `rgb(17 33 45 / 72%)` |
| `--panel-strong` | `rgb(255 255 255 / 94%)` | `rgb(17 33 45 / 82%)` |
| `--panel-row` | `#f6f5f1` | `rgb(37 55 69 / 55%)` |

Shadows are the one thing the current app has none of, and the design leans on them to
separate a white card from a white page. Four, and no more:

```
--lift-button: 0 6px 24px rgb(18 33 43 / 12%);   /* floating map buttons */
--lift-panel:  0 10px 32px rgb(18 33 43 / 16%);  /* the floating card    */
--lift-sheet:  0 -10px 32px rgb(18 33 43 / 14%); /* the expanded sheet   */
--lift-row:    0 1px 3px rgb(18 33 43 / 6%);     /* a list card          */
```

In dark they go to near-black at higher alpha; a shadow tuned for white is invisible on slate.

### Geometry and type

Radii: `999px` chips · `10–12px` inline buttons · `14px` map buttons, list cards, inset
tiles · `16px` primary buttons and grouped cards · `22–24px` panels and sheets.

Sizes: 46px map buttons · 56px primary buttons · 44px minimum tap target · 40px back buttons.

Type is the system stack, unchanged — no webfont, because the app must work offline.

| Role | Size / weight |
|---|---|
| Screen title | 28 / 700, `-.02em` |
| Sheet title | 20 / 700, `-.01em` |
| HUD figure | 30 / 700, `-.03em` |
| Stat figure | 22–26 / 700, `-.02em` |
| Primary button, row title | 17 / 600 |
| Body, row label | 15–16 |
| Muted note | 13 |
| Section label, unit | 11–12 |

`font-variant-numeric: tabular-nums` on every figure, as today.

### What does not change

- **Route line colours.** They are ΔE-tested against both basemap palettes and are not chrome.
  `style.test.ts` keeps its ΔE ≥ 16 floor over `ROUTE_PALETTE`.
- **The basemap palettes**, the land-cover tiers, the path filters, the region colours.
- **`GRADE_BANDS`.** Six considered bands beat the design's five illustrative ones. They are
  checked for contrast on the new white panel and adjusted only if one fails.
- **Everything below the UI**: engine, VFS, tile store, download queue, region partition, GPX
  parsing, the parity corpus.

## Screens

### 1 · First run — `src/onboarding/`

Six cards, swipeable, skippable, shown once. New directory, because it is the one part of the
app that is neither the ride nor what supports it.

Each card is a 300px slate tile with a pixel glyph, a 28px title, a 16px body. The pager is a
row of dots (8px, the current one 22px wide) and a 56px primary button; a back chevron appears
from card two. `Skip` sits top-right beside the app icon and name.

The glyphs are the six in the design's `G` map — bike, Britain, taps, bikes, climb, locate —
drawn on a 20×14 grid from a character map, in the icon's two greys (`#ccd0cf`, `#8fa3ab`)
plus the trekking amber `#fec241` and the good green. They ship as a data module rendered to a
CSS grid, not as images: the grid is a handful of bytes, editable in place, and cannot 404.

Card four asks what you ride. The answer sets three defaults at once — the route style offered
first, the riding position and the tyres — all overridable later in *You and the bike*:

| Chip | Style | Position | Tyres |
|---|---|---|---|
| Hybrid / town | `trekking` | `upright` | `allroad` |
| Road | `fastbike` | `hoods` | `road` |
| Gravel | `gravel` | `hoods` | `gravel` |
| Mountain | `mtb` | `upright` | `mtb` |

Card six asks for location, with the design's one-line reassurance. Its button reads *Allow
location & start* and calls `geolocation.getCurrentPosition` from that tap — iOS only prompts
from a gesture.

**Where it sits in the launch sequence.** Onboarding, then the existing first-run maps gate,
then home. It is stored under its own key (`free-wheel.onboarded.v1`) and is *not* the same
question as "is there anything installed": a rider who deletes every region gets the maps gate
again, not the walkthrough. Skip counts as seen.

### 2 · Home and planning — `RideView` + the route sheet

The rail of seven buttons becomes two, bottom-right, 46px: **Layers** and **Locate**. Theme,
path mode and the follow control move into a Layers sheet — a small vaul drawer of rows.

A hint pill floats under the status bar, carrying the sentence the old `.rail-hint` carried:
*Tap the map to set your start* → *Now tap where you're heading* → the routes.

The bottom card is the redesigned `sheet-bar`, and it has three states:

- **Empty** — pin tile, *Plan a ride* / *Start, then finish. We do the rest.*, and two 48px
  buttons: *Saved* and *Setup*.
- **One point** — a two-row grid: `S` badge, the start, a `×`; a dotted connector; a dashed `F`
  badge and *Tap the map for your finish*. Footnote about dragging pins.
- **Routed** — the route cards, below.

Placing the second waypoint triggers the run automatically. No Compare button.

### 3 · Choosing a route — the model change

The three cards are the first three profiles under plain-language names. `profiles.ts` grows a
`plain` field so the engine id, the technical name and the rider-facing name are one record:

| Engine id | Technical | Plain | Note |
|---|---|---|---|
| `trekking` | Trekking | **Relaxed** | Quiet roads, decent surfaces |
| `fastbike` | Fast | **Fast** | Road bike; speed over quiet |
| `gravel` | Gravel | **Off-road** | Happy on unsurfaced tracks |
| `fastbike-verylowtraffic` | Fast, quiet | Fast, quiet | Road bike, traffic-averse |
| `mtb` | MTB | MTB | Off-road, the rough kind |
| `shortest` | Shortest | Shortest | Distance only |

A card is a 12px colour bar, the plain name, the note, and the figures right-aligned. The
chosen card takes a 2px ink border and the `--inset` fill, and grows a **Details ›** row —
which, with the drag handle, is how you reach the detail view. The design's mountain icon is
gone.

`plan.selection` becomes the *first three* by default rather than one, and `chosen` keeps its
meaning exactly: `null` until the rider picks. The single-route auto-commit in `chosenAfterRun`
still applies and is what the distance guard falls back on.

**The distance guard.** `useRoute.run` already measures air distance for `longRouteWarning`.
Above `COMPARE_CEILING_M` (50 km air) it routes only the rider's default style; the other cards
render as *tap to compare* and route on demand. Below it, three run sequentially as designed,
and each result appears as it lands rather than all three at the end.

50 km is a third of `AIR_DISTANCE_CEILING_M`, and deliberately: that constant is the point
beyond which *one* route gets uncomfortable, and this is the point beyond which *three* do.

`shortest` has no energy model, so its `timeS` is `null` — the card shows `—`, never `0 min`.

### 4 · Route detail — the expanded sheet

Today's detail view, restyled: a swatch, the plain name, a *Trekking profile* pill naming the
engine profile, three stat tiles, the elevation profile in the route's colour, the climb list,
and four icon buttons — Save, Export, Reverse, Clear. *Start ride* is pinned to the foot in the
same place it occupies on the card, so the thumb does not move.

Heights are still the gate: no `hasElevation` means no profile and no climb list, replaced by
the existing sentence. A flat chart is a claim that the road is level.

### 5 · Sheet motion — design 2b

The floating card and the expanded sheet are the two states of one surface.

| | Value |
|---|---|
| inset | 12px → 0 (left, right, bottom) |
| radius | 24px all → 24px 24px 0 0 |
| height | content → viewport − 60px |
| curve | 500ms `cubic-bezier(.32, .72, 0, 1)` |
| content | cards fade out 150ms; detail fades in 250ms, 100ms late |
| map | dims to 25% ink behind the expanded sheet; the camera is untouched |
| footer | *Start ride* pinned; bottom padding 12 → 12px + safe area |

Implemented as today's split — a bar in the chrome layer and a vaul drawer portalled to the
body — rather than one vaul sheet with snap points. vaul already handles velocity,
rubber-banding, scroll/drag disambiguation, focus trapping and inert background correctly, and
none of it is interesting to rewrite. The card is styled as the minimised state and the drawer
as the expanded one, so the two read as one surface moving.

Applies to: route cards → detail; Ride finished (arrives expanded); the Maps sheet stays
minimised, since it never has more than one thing to say.

### 6 · Riding — `RideHud`

Closest to what exists. Four figures at 30px, the lookahead as a 52px gradient strip, a 6px
progress bar, the one-line callout with a colour tick. The fold to a strip stays, including its
measured-height mechanism — this remains the one place the "don't animate a backdrop-filtered
box's height" rule is knowingly broken.

Two changes of substance:

- The three riding buttons keep their positions; Voice takes the ink fill when on.
- The foot bar becomes elapsed / distance / ascent plus the fix line, and **End** becomes
  **hold to end** — a 600ms press with a fill that tracks it, on `--bad-bg`. A tap that ends a
  ride by accident is the expensive mistake here; a hold cannot be made by a bump.

### 7 · Ride finished

The existing summary, in the design's shape: a green tick, *Ride finished*, the date and
*saved on this phone*, six stat tiles, the power/work sentence with its "it is not a power
meter" caveat, a rename row, and *Export GPX* / *Done*. Renaming here is correct and already
the rule — the riding screen carries no text field because iOS shake-to-undo cannot be
refused.

### 8 · Saved — `src/library/SavedScreen.tsx`

Promoted out of the drawer to a full-screen overlay over the map, mounted like Setup so no
OPFS handle or tile cache is dropped. A 28px title with a back button, a three-way segmented
filter (All / Planned / Ridden) over the existing `libraryModel`, and rows of: a 52px SVG
thumbnail of the route's own geometry in its profile colour, the name, the meta line, a
Planned/Ridden tag. A footer says everything lives on this phone only.

The thumbnail is drawn from the stored coordinates, normalised into a 52×52 box — a real
shape, not the design's illustrative squiggle.

`useRouteSheet`'s `library` view and `RouteLibrary`'s list half go; the ride-detail half is
reused by the new screen.

### 9 · Setup

`SetupView` becomes a short list — *Maps on this phone*, *You and the bike* — with
*Diagnostics and engine parity check · Open* as a footer link. Each row pushes to a full
screen with a back button. The tab strip and its sliding indicator go.

**Maps on this phone** keeps `MapsScreen`'s logic and takes 1i's shape: a *Where you are*
suggestion at the top, then *On this phone · N regions · X MB*, then rows carrying a state swatch in
the region's own colour, a progress bar while downloading, and Stop. The note about
neighbouring regions sharing road data, and the manual-import escape hatch, stay as a footer.

*Where you are* is the region whose `REGION_SEEDS` entry is nearest the last known fix, among
the regions whose published box covers it — the same clip `regionShapes` already applies, so a
seed can only redistribute published coverage. **With no fix the section is not drawn at all.**
Suggesting an arbitrary region would be a confident guess about where someone lives, and the
region list below it is already the answer.

**You and the bike** keeps `RiderPanel`'s model: two mass rows, four position cards, four tyre
chips, the ink "What that adds up to" card with the two sanity figures and the total mass, and
the switches. The third switch — *Keep my maps and road data* — is wired to
`navigator.storage.persist()`.

## Files

New: `src/onboarding/` (screen, slides, glyph data, glyph renderer) ·
`src/library/SavedScreen.tsx` · `src/ride/LayersSheet.tsx` · `src/ride/RouteCards.tsx` ·
`src/setup/SetupMenu.tsx` · `src/ride/HoldButton.tsx` · `src/tokens.css`.

`tokens.css` takes the `:root` colour block out of `index.css`, which keeps the `border-box`
reset and the document rules it was written for. Both themes live in one file because the
whole point of the dark variant is that it is the same names with different values, and two
files is how they drift.

Reshaped: `ride.css`, `App.css`, `index.css`, `RideView.tsx`, `RouteSheet.tsx`, `RideHud.tsx`,
`RideSummary.tsx`, `SetupView.tsx`, `MapsScreen.tsx`, `RiderPanel.tsx`, `RouteLibrary.tsx`,
`profiles.ts`, `plan.ts`, `useRoute.ts`, `useRouteSheet.ts`, `rider.ts`, `App.tsx`.

Untouched: everything in `src/engine/`, `src/map/` except the theme hook-up, `src/data/`,
`regionShapes.ts`, `regionLayers.ts`, `BrowseMap.tsx`.

## Testing

The rule stands: prefer adding to a corpus over writing bespoke assertions.

- **`style.test.ts` keeps its ΔE floor** over `ROUTE_PALETTE` against both basemap palettes.
  Chrome colours are not map colours and are not added to it.
- **A new `chrome.test.ts`** asserts the contrast the light theme now has to earn: ink on page,
  muted on page, muted on card, and every `GRADE_BAND` colour against `--card`, at WCAG AA for
  text and 3:1 for the graphical bands. This is the test the dark-only app never needed.
- **`profiles.test.ts`** — every profile has a distinct `plain` name; the first three are the
  ones the cards show; `isRoutableProfile` still excludes `recorded`.
- **`plan.test.ts`** — migration from a v3 plan with a one-profile selection to the new
  three-profile default, without losing a stored route.
- **`useRoute`'s distance guard** — pure, extracted, tested at either side of the ceiling.
- **`onboarding`** — the slide model and the bike → defaults mapping, pure and tested.
- **`libraryModel`** already has tests; the thumbnail normaliser gets its own.

Then the rule that outranks all of it: **on-device, added to Home Screen, airplane mode, cold
launch, plan a route, follow it.** A desk cannot answer whether a white panel is legible in
sunlight, whether the hold-to-end is the right length with gloves on, or whether the sheet
motion judders over a moving map. This spec is not finished until that ride happens.

## Risks

1. **Light chrome in sunlight and at night.** The reason the app was dark. The dark variant is
   the mitigation, but the *default* is now light and the day/night control is the only way
   out. If the ride says otherwise, the honest fix is to default the chrome from the basemap
   theme rather than to repaint everything again.
2. **Three sequential routes on the second tap.** Guarded by distance, but the guard's ceiling
   is a guess until it is ridden. Results appearing one at a time is what keeps it bearable.
3. **Scope.** This touches every screen. Staged commits and the existing test suite are the net;
   the engine, the VFS and the map are deliberately outside the blast radius.
4. **The sheet motion over a moving map.** Backdrop-filtered surfaces animating on iOS is a
   failure this repo has already hit once, on the control rail. If it judders, the expanded
   sheet loses its blur and becomes opaque — it covers the map anyway.
