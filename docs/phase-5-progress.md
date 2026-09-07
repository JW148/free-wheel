# Phase 5 — the basemap re-read

Written 2026-09-07, after the first real ride.

The ride produced one dominant complaint: the map is hard to orient by. Held next to Apple
Maps the reason was obvious — Apple separates built-up ground from green ground and free-wheel
did not. The rider's second complaint was that cycle infrastructure is invisible compared with
CyclOSM/OpenCycleMap.

This phase fixes the first complaint. The second turns out to be **impossible from the current
data**, which is the most important finding here and is recorded in full below.

## The headline

The archive already contained everything needed. The style was throwing it away.

`landuse` carries **43 distinct `kind` values** — `farmland`, `wood`, `forest`, `grass`,
`meadow`, `scrub`, `park`, `garden`, `residential`, `industrial`, `commercial`, `school`,
`cemetery`, `pitch`, `golf_course`, `wetland`, `bare_rock` and more. The style painted all 43
with a single `fill-color` at `fill-opacity: 0.5`.

Measured, that gave:

| pair | before | after |
|---|---|---|
| park vs earth | **2.43** | 17.85 |
| park vs building | **2.13** | ~18 |
| park vs residential | **0** (same colour) | 17.94 |
| farmland vs grass | **0** (same colour) | 11.13 |
| water vs earth, as a fill | 9.4 | 17.16 |

ΔE 2.4 is at or below the just-noticeable difference. A park and a building were *the same
colour*. The map was not under-designed, it was under-**read**.

Note the "before" figures include the `fill-opacity: 0.5` blend against earth, which is what
was actually on screen. The unblended palette values measure ΔE 4.6 and 2.8 — the numbers
quoted in the first analysis of this problem, and too flattering by roughly half.

## What could not be done, and why

**NCN route numbers cannot be rendered from this archive at any zoom.** The `roads` layer has
`network` and `shield_text` fields, which looked promising. Scanning 137 tiles, every value is
a road shield — `UK A Road Network`, `GB:trunk`. There is no `ncn`, `rcn` or `lcn` anywhere.
Protomaps' basemap does not carry `route=bicycle` relations, so the numbered blue and purple
network in the CyclOSM screenshot has no source in the data we ship.

**Unnumbered cycleways are absent below z14.** Protomaps stamps `min_zoom: 14` on cycleway
features, so a z12 or z13 tile contains almost none — a 137-tile z12 scan found *zero*
cycleways against 241 tracks. That is exactly the city-overview zoom the CyclOSM comparison was
taken at. Re-extracting deeper does not help: `min_zoom` is baked into the upstream build.

Getting this would mean a **new data pipeline** — planetiler over a Geofabrik extract,
producing a cycle-only PMTiles overlay with route relations and cycleways down to z10. That is
a new subsystem, and the user deliberately deferred it to keep this revision style-only.

## Two other findings worth keeping

**`--maxzoom=16` produces a byte-identical archive to `--maxzoom=15`.** 15,017,657 bytes both
times on a test bbox. z15 is the upstream build's maximum; asking for more is silently
ignored. Do not bother.

**Building footprints effectively do not exist in our archive.** 22–35 buildings per z14 tile
in central Edinburgh, because Protomaps only ships real footprints at z15. The equivalent z15
tile has **1,568** — roughly 180× more per unit area. A `--maxzoom=15` extract costs 2.6×
(Edinburgh 34 MB → ~88 MB), and the user chose not to pay it, so the `buildings` layer in the
style still renders almost nothing at our max zoom. It is left in place: harmless, and correct
the moment anyone extracts deeper.

## The chroma ceiling was misread — it only ever applied to lines

`docs/phase-4-progress.md` records "every colour in both basemap palettes is C ≤ 15.1", and
that constraint is what keeps a route line from reading as map furniture. It looked like a
blocker for colouring the land.

It is not, and the reason matters. The figure comes from `pathTrack` — the most colourful
**stroke** in the basemap. The argument behind it is that a vivid 5px route line must not be
confused with a muted 3px line belonging to the map. That is a claim about *lines*. A route
stroke is in no danger of being confused with a park-sized area of pale green.

So the ceiling now applies to strokes only, and land fills go above it — `park` sits at C 23.6
against `pathTrack`'s 15.30. Both are asserted separately in `style.test.ts`, including a test
that fails if someone "restores consistency" by pulling the fills back under the line ceiling.

Two corrections to the older documents while measuring this:

- The quoted ceiling of **15.1 is the dark theme's** `pathTrack`. The light theme's has always
  been C 15.30. The assertion is set at 15.4.
- `src/ride/profiles.ts` claimed the closest approach of any route colour to any basemap colour
  was **ΔE 18.0**. It was **15.5** — `fastbike` against the dark theme's water *label*. The
  original measurement covered fills and strokes but not label colours. That label has now been
  lifted to `#8d9aa6`, and the true worst case is **17.15** (`fastbike` against light water) —
  so the new palette is measurably better than the one it replaces, not a regression.

## Why tiers instead of one data-driven layer

The obvious implementation is a single `fill` layer with a `match` on `kind`, the way `paths`
handles dash patterns. It does not work, and the reason is not obvious until it bites.

Landuse polygons **overlap constantly**: a park inside a residential block, a pitch inside the
park, a garden inside a terrace. Within one layer MapLibre paints features in whatever order
the tile lists them, and **Protomaps stamps `sort_rank: 189` on every single landuse feature**
— there is no ordering signal to sort by. A park would sometimes be painted *under* the
residential polygon containing it and simply vanish.

`fill-opacity: 0.5` in the old style was hiding exactly this: blending made draw order stop
mattering. It also produced a colour at every overlap that nobody chose, and it is most of why
the map looked washed out.

So: **five opaque tiers**, ordered by specificity, most specific on top.

```
land-built    residential, industrial, aeroway, institution, pedestrian, military, other
land-open     farm, bare, glacier, scrub, wetland
land-garden   garden
land-green    wood, grass, cemetery
land-park     park, sport
```

Each is emitted against `landuse`, and against `landcover` (suffix `-low`) **only where
`landcover`'s six-kind vocabulary can actually fill it** — `land-garden-low` and
`land-park-low` would filter for kinds that source-layer has never heard of and could never
draw anything, so they are not emitted at all. That takes the basemap from 15 layers to 22.
Draw order becomes a property of the layer list, which we control and can test.

## `landcover` is live at z3–z7 only

The old style gave `landcover` a flat green fill. It has **zero features at z8 and above**,
which is where anyone actually rides, so that layer was doing nothing useful.

It is live at z3–z7, with six coarse kinds: `urban_area`, `farmland`, `forest`, `grassland`,
`barren`, `glacier`. `urban_area` is the only built-up signal that exists at continent zoom.
`landuse` takes over from z7 (644 features at z7, 1,037 at z8), so both are drawn and the
`landcover` tiers sit underneath. They share the class taxonomy, so the two views agree about
what green means where they meet.

## Private gardens are not parks

`garden` is the most common kind in the archive by a wide margin: **1,914 polygons in one 2×2
block at z13** against 64 actual parks, median area 17 px². These are Edinburgh's back gardens.

Mapped to the park tone, every tenement street reads as parkland and the one colour that should
mean "open space you can use" is diluted. `garden` therefore gets its own tone — ΔE 10.0 from
earth so it reads as leafy, ΔE 8.4 *below* `park` so it is never mistaken for one — and sits in
a tier below the real greenery so it can never obscure a park it touches.

## Railways were being drawn as roads

Not part of the brief, but found while auditing the `roads` layer and cheap to fix. `roads`
carries `kind: 'rail'` (265 features in a 137-tile scan) and the old filter excluded only
`path`, so every railway got the road colour *and* the full 8px road casing. A main line looked
like a street you could ride down — the opposite of what a railway means to a cyclist. It now
has its own thin dashed layer, and `roads`/`roads-casing` exclude it.

## The warm earth is load-bearing

Light `earth` moved from `#eef0ef` to `#f4f2ed`. This looks cosmetic and is not.

Against the old cool near-neutral base, blue water could reach only ΔE 15.7 before colliding
with the `fastbike` route line, and the whole map read faintly green once the land was
coloured — a cool base next to green reads as pale green. A warm base gives every cool and
green surface room to separate. With it, water clears ΔE 17.2 from *both* earth and the route
line.

## A linear-water colour was tried and abandoned

Canals and streams are drawn as lines from the same `water` source-layer, and a pale lake fill
makes a thin line. A dedicated darker, more saturated `waterLine` was the obvious fix.

It failed the route-clearance rule badly. At any chroma that made a canal read clearly it
landed **ΔE 9.4** from the `fastbike` route line — precisely the failure the stroke ceiling
exists to prevent, and worse than anything in the palette it was meant to improve. No value at
C ≤ 15 cleared ΔE 15.

Linear water therefore reuses the water *fill* colour. That still gives a canal ΔE 17.2 against
earth, against the 9.4 the shipped style managed — so the problem is substantially fixed
without a new colour. A canal towpath is one of the better things to be riding on, so this
mattered more than it looks.

## The rules are now executable

`docs/phase-4-progress.md` recorded its constraints as measured figures in prose. Prose does
not fail a build, and that palette has since been edited twice — one of its figures was wrong
for months, as above.

- **`src/map/colour.ts`** — CIELAB, CIELCh chroma, CIEDE2000. Verified against **all 13 pairs**
  of Sharma, Wu & Dalal's reference data, including the zero-chroma case where the mean hue is
  undefined and the discontinuity at exactly 180°. Writing that test caught two mis-transcribed
  *expectations* of my own before they were baked in. Used only by tests.
- **`src/map/landcover.ts`** — the taxonomy and the tier order.
- **`src/map/style.test.ts`** — the palette rules as assertions: the stroke ceiling, a test
  that fills exceed it, route clearance over *every* colour including labels, and the
  design-intent separations in the table at the top of this document.

`landcover.test.ts` asserts the taxonomy covers all 43 `landuse` kinds and all 6 `landcover`
kinds, harvested by decoding ~150 real tiles. A kind added by a future schema version fails the
build instead of quietly getting the fallback colour. The first draft of the taxonomy assumed
28 kinds and silently missed `other`, `platform`, `dog_park`, `pier`, `zoo`, `dam`,
`village_green`, `national_park` and `glacier`.

## Verified

- 93/93 unit tests pass, `tsc -b` clean, `vite build` clean, no new lint findings.
- The existing `style validity` test earned its place again: it caught a `match` expression
  whose label arrays had been flattened open, which MapLibre reports as "Could not parse color
  from value 'farmland'". That is the silent-map class of bug the test was written for.
- Palettes rendered from the real archive at z12/z13/z14 in both themes, before and after.

**Not yet verified on a physical iPhone.** Per `CLAUDE.md` that is the only verification that
counts, and it is the next action — specifically the light theme in direct sunlight, which is
the condition the whole light palette exists for and the one a desk cannot reproduce.
