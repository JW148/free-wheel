# Phase 10 — choosing a region on a map you already know

**Status: built, tested, and driven end to end in headless Chrome at a true 390 px against the
live mirror.** A region was browsed, selected on the map, selected by name from the drawer,
located from a GPS fix, downloaded, cancelled, and downloaded to completion; both themes were
checked. Not yet ridden and not yet on a physical iPhone — the acceptance test in `CLAUDE.md`
still applies.

Phase 9 put fourteen regions on one screen and drew them as fourteen translucent **rectangles**
over a map of Britain. That is the honest shape of the underlying data — a region is published
as a bbox because that is what `pmtiles extract` takes — and it was the wrong thing to put in
front of a rider. Three things were wrong with it, and they compounded:

1. **The boxes overlapped.** Every one of the fourteen shares an edge band with a neighbour, so
   at any fill opacity that read clearly the coastline disappeared under a stack of blue
   rectangles. The fix in Phase 9 was to hold the fill at **0.06**, which made the fill almost
   invisible and left the outline doing all the work. The thing the colour was for — *which part
   of the country is this, and have I got it yet* — could not be seen.
2. **A box is not a place.** A rider knows what Britain looks like. A rectangle in the sea off
   Aberdeen is a thing they have to decode, and the decoding is the whole cost.
3. **The chrome took two thirds of the screen.** A bar at the top holding nothing but a back
   button, and a sheet at the bottom capped at 21 rem that could not be dismissed — so on a
   667 px phone the map got a band in the middle.

## What was built

```
web/src/setup/
  regionShapes.ts       the partition: boxes -> non-overlapping areas, seeds, names   (new)
  regionShapes.test.ts  forty British cities, checked against where a rider would put them
  regionLayers.ts       rewritten: fills under the basemap water, achromatic divides
  BrowseMap.tsx         memoised geometry, selection framing, padding from the caller
  MapsScreen.tsx        browse is a full-height map, one bar, and the ride screen's drawer
  pickerModel.ts        statusLine + priceLine + sheetPrice -> one `regionLine`
```

### The sea is drawn by the basemap, not by us

The single decision the rest of this rests on: the region fills and divides are inserted
**below the basemap's own `water` fill**, using `beforeWater()`. Water is opaque, so it renders
in MapLibre's opaque pass and writes depth; the region fills are translucent and depth-tested
against it in the translucent pass. The sea therefore clips every region exactly, for free, in
both themes and at every zoom, and nothing in the app has to know where the coast is.

The shapes themselves are still square-cornered rectilinear blocks running well out over the
water. None of that is ever seen.

*Not* a bug, though it took a red line and a screenshot to establish: the divides are clipped by
the same mechanism. What looked like a boundary drawn across the Firth of Lorn was a boundary
drawn across the *land tint*, which at 0.3 blue over dark earth is close enough to the water
colour to be misread.

### Deepest-inside failed; a written-down seed did not

Three rules were tried for deciding which region owns a place both cover.

| Rule | What it broke |
|---|---|
| Nearest box **centre** | Central Scotland's box is wide, Southern Scotland's is tall. The midpoint between the centres fell north of Edinburgh, so the Central Belt was painted as the Borders. |
| **Deepest inside** the box (distance to the nearest edge) | Fixed Scotland, then broke four English cities: Manchester → Yorkshire, Hull → East Anglia, Carlisle → Scotland, Shrewsbury → Wales. |
| Nearest **seed**, clipped to the boxes that cover the cell | All forty probe cities land where a rider would put them. |

The four failures are one failure. A box is a *download extent*, drawn with generous and
deliberately asymmetric overlap, so a city can sit 20 km inside its own region's edge and 60 km
inside its neighbour's. Manchester is 0.24° from the east edge of the North West box; no
measurement of that box recovers an intent nobody wrote into it.

So `REGION_SEEDS` writes it down: fourteen entries, each the heart of a region, each a real place
on land. A cell goes to the nearest seed **among the regions whose box actually covers it**, and
that clip is what keeps the whole thing honest — a seed can only ever redistribute published
coverage, never invent it. `regionShapes.test.ts` asserts every seed lies inside its own box, and
that the painted area is a subset of it.

Two regions need two seeds. North West England is long: a single seed anywhere in the Lakes gives
Manchester to Yorkshire, and a single seed anywhere near Manchester gives Carlisle to Scotland.
East Anglia's second seed is Lincolnshire, which is in the region's *name* while the Midlands box
reaches east to Lincoln.

### The partition, and why it is a grid

A uniform 0.05° grid — about 36,000 cells over Britain, 15 ms to partition. Cells merge back into
**160 maximal rectangles** for the fill and **384 collinear runs** for the divides, so MapLibre
receives 22 KB of GeoJSON rather than nine thousand slivers.

0.1° was tried first and the staircase down the middle of Scotland was visible at the zoom this
screen opens on. The divides between seeds are diagonal, so a grid built from the box edges (the
obvious choice) would have rendered one as two or three enormous steps.

The outline is deliberately **not traced into closed rings**. Ring tracing needs junction
disambiguation wherever two blocks touch at a corner, and nothing wants a ring: the fill comes
from the rectangles, and a line layer draws a MultiLineString of open runs exactly as well.

`fill-antialias: false` is load-bearing. It draws an outline around *every ring*, which would
trace each of those 160 rectangles in the fill colour and put the grid straight back on screen.

### Fourteen names, and the two things that stopped them appearing

Naming the areas is most of what makes this readable, and MapLibre drops a colliding label rather
than shrinking it — so the count of names actually drawn is the measurement that matters.

- **Short names at country zoom.** `text-field` is `['step', ['zoom'], short, 6.5, name]`. With
  the published names, five areas came out unlabelled: Southern Scotland, the North West, East
  Anglia, Wessex and Kent. `text-padding` also went from 6 to 2 — padding *is* collision margin.
- **Symbols are placed top down.** `PauseablePlacement.continuePlacement` counts the layer order
  *down* from the end, so the topmost symbol layer takes the collisions it wants. Moving the
  names under the basemap's own labels — on the theory that placement ran bottom-up — took the
  count from 13 to 10. It is a measurement, not a preference.
- The last missing name was **Yorkshire**, which lost to North West England's: 1.4° apart, which
  at this screen's opening zoom is 50 px between two labels needing 57. Both seeds moved to put
  them 1.7° apart. The seeds move together because the seed *is* the anchor.

14/14.

### Colour says state, shape says selection, and everything else is achromatic

Nothing overlaps any more, so the fills are finally strong enough to mean something: 0.30
available, 0.44 in flight or installed, 0.62 selected, fading to 40 % of each by z10 so the street
map is usable underneath. The three colours in `REGION_COLOURS` are unchanged and still clear
ΔE 16 from every colour in both palettes.

`unknown` — installed, but offline and unable to check for an update — moved from the available
blue to the installed green. It *is* on the phone, which is what the colour answers; whether it is
the newest copy is a sentence, and the bar says it. The old fallthrough told a rider to download
something they already had.

The divides, the selected ring and the names are the theme's own `text.label` — white on dark,
near-black on light. That is a **lightness** effect, so it needs no clearance from the palette,
survives dichromacy, and reads over a fill of any colour. It is the same rule the two ride
overlays follow, and it exists because the search for a fourth region colour came back empty:
six route hues and three region colours have used the usable circle up.

**A dash cannot read as gaps here.** Every region draws its own edges, so an internal divide is
drawn twice — once by each side — and the neighbour's hairline sits in the gaps. The in-flight
divide is therefore three times the width and more than twice the opacity as well as dashed, and
what a rider sees is the *weight*. Folding the dash into a data-driven `line-dasharray` on both
line layers was still worth it: a separate pending layer drew *under* the selection ring, so a
region downloading because the rider had just tapped it — the usual way round — looked exactly
like one sitting still.

### One bar, and a drawer that goes away

The top bar is gone; its one control moved into the bottom bar, which is built from the ride
screen's own `.sheet-bar` vocabulary — the middle *is* `.sheet-toggle`, the action *is*
`.primary`. Three slots, always in the same places: out, what is chosen, and the one thing to do
about it. 68 px tall, and it stays 68 px: both lines are clamped to one line with an ellipsis,
because "Southern Scotland and the Borders" over a price that wrapped to three lines grew the bar
and moved Download out from under the rider's thumb.

The list is now the ride screen's `vaul` drawer, and it starts **closed**. That is the whole of
the space complaint: the map has the screen until a rider asks for names. Picking a row frames
that region on the map and closes the drawer; picking on the map does not move anything, because
the ground must not shift under the finger that just landed on it. `BrowseMap` tells those two
apart by the *identity* of a `frame` object, since both produce the same `selectedId`.

`statusLine`, `priceLine` and `sheetPrice` — three sentences written for a sheet that no longer
exists — collapsed into one `regionLine`, capped at 28 characters by a test, because the slot it
is drawn in is 176 px wide.

## What was measured

| | |
|---|---|
| Partition | 15 ms, 36,000 cells → 160 rectangles + 384 runs, 22 KB of GeoJSON |
| Region names drawn at opening zoom | **14 of 14** (was 9, then 11, then 13) |
| Bar height, empty and with a 33-character region name | 68 px both |
| Probe cities landing in the region a rider would name | **40 of 40** |
| Tests | 577 passing |

Both themes were checked, and a 166 MB region was downloaded to completion, cancelled mid-flight
and re-offered.

## What is not done

- **Never ridden, never on a physical iPhone.** Unchanged from Phase 9, and it is the same
  acceptance test.
- **Bristol is in Wessex and Perth is in the Highlands.** Both are defensible — the South West
  box stops at −2.4 and the Central Scotland box stops at 56.4, so both cities sit on the fringe
  of the region they would be named for. Both would need the *published boxes* to change, which
  means re-running `mirror:basemaps`, not a seed edit.
- **Stranraer is in no region at all.** Southern Scotland's box starts at −5.0 and Stranraer is
  at −5.03. The partition paints this correctly as uncovered, which is the first time the gap has
  been visible; it is a `regions.json` problem, not a rendering one.
- **The staircase is visible if you look.** 0.05° is about 3 px at opening zoom, and the selected
  ring at 2.5 px shows it. 0.025° would quarter it and quadruple the partition cost, which is
  15 ms on a Mac and unmeasured on a phone.
- **A region with no seed falls back to its box centre**, which may be at sea. That is what a
  region published after this file was written gets, and it still works.
