# Phase 9 — the maps library, and a map that does not stop at a border

**Status: built, tested, and driven end to end in a real browser against the live mirror.** A
region was downloaded, cancelled, resumed, installed, drawn and removed; two overlapping
archives were mounted at once and each proved present by flying to territory only the other
lacks. Not yet ridden, and not yet run on a physical iPhone — the acceptance test in `CLAUDE.md`
still applies.

This phase started from two observations about Phase 8's region picker:

1. **You could download exactly one region, ever.** `RegionPicker` mounted only while
   `needsSetup` was true, which was computed once at launch and only ever flipped false. After
   the first download it was unreachable for the life of the install. The only route to a
   second region was the manual `.rd5`/`.pmtiles` import.
2. **The map stopped at the region boundary.** One `basemap` source, one archive. Two regions on
   a phone meant one on screen, switched by raw filename in Setup. Routing crossed the border
   perfectly well — segments are 5° BRouter cells, shared between regions, all in one
   `/segments4` — so the failure was: the route works, the map is blank. Which looks like
   breakage rather than a limit.

The published regions *overlap by design* (Yorkshire reaches north to 54.6, North East England
south to 54.0), so a rider in Sheffield or Carlisle straddles two as a matter of course. This is
not an edge case.

## What was built

```
web/src/map/
  style.ts             basemapStyle takes a list; ids carry role|archive; roleLayers extracted
  composite.ts         splicing one archive into a live map, ordered by role       (new)
  archiveChoice.ts     mountPlan: the diff between installed and mounted, not a choice
web/src/ride/
  useMapLibre.ts       multi-archive; `sync` replaces show/refresh/showRemote/endRemote
web/src/setup/
  MapsScreen.tsx       library + browse, one screen                                (new)
  BrowseMap.tsx        its own MapLibre instance over the streamed Britain archive (new)
  ManualImport.tsx     BasemapPanel + TilesPanel folded into one disclosure        (new)
  downloadStore.ts     the queue, as a module singleton                            (new)
  downloadQueue.ts     the queue's rules, pure                                     (new)
  libraryModel.ts      storage arithmetic, removal price, "where you are"          (new)
  regionLayers.ts      a fourth painted state, on shape rather than hue
web/src/engine/
  downloads.ts         AbortSignal through the fetch and between chunks
  regionStore.ts       the signal through the item loop
  engineApi.ts         cancelRegionDownload; deleteBasemap
  engineClient.ts      removeRegion and cancelRegionDownload exposed
```

Deleted: `setup/RegionPicker.tsx`, `map/BasemapPanel.tsx`, `engine/TilesPanel.tsx`.

## The four decisions worth keeping

### Layers interleave by role, never stack by archive

The obvious construction — archive A's whole stack, then archive B's — is wrong in a way that
reads as a rendering bug. In the shared band both archives have data, and stacked that way
B's *land fills* paint over A's *roads*: streets that stop along a line across the map.

So the order is role-major. Every `earth`, then every land tier, then every `water`. Layer ids
carry both halves (`roads|yorkshire.pmtiles`) because MapLibre ids are flat strings and
everything generic — the path-mode filter, the incremental insert — has to recover the role from
the id alone. `composite.test.ts` asserts the property that matters: splicing B into a live map
holding A gives the same order as building the style with both from scratch.

Two archives drawing the same road draw it identically, and two archives labelling the same town
collide in MapLibre's symbol placement so only one survives. The overlap costs nothing once the
order is right.

### The picker stops borrowing the ride screen's map

Phase 8's picker streamed Britain over the *shared* MapLibre instance and handed it back on the
way out. That handback was the most delicate thing in the app: an async teardown racing React's
effect ordering, three recorded rounds of fixes, and a failure mode where a rider ended up
looking at a streamed map of Britain wearing their own map's clothes.

None of it was ever about picking a region. It was the cost of there being one map. `BrowseMap`
builds its own over its own container and `remove()`s it on unmount — synchronously, nothing to
hand back, nothing to race. `showRemote`, `endRemote`, `displacedRef`, `loanGeneration`,
`handbackPlan`, `mayStandDown` and `handbackCopy` all went with it.

The price is two WebGL contexts while the screen is open. The benefit beyond the deleted
complexity is that a rider who opens Maps mid-ride and closes it again is exactly where they
left off — the route line, the position and the tile cache are never touched.

### Downloads outlive the screen

`downloadStore` is a module singleton like `sharedEngine`. Tap four regions and put the phone in
a pocket. The rows are a *view* of the queue, which is why they survive unmounting, and why
`App` — not the Maps screen — subscribes to `onInstalled` and splices the new archive in: the
screen is very often not mounted when a download lands.

A finished region joins the map by `addSource` + one pass of `addLayer`. Not `setStyle`, and not
a new `Map`: either would take the route line, the position dot and the waypoint markers down
with it, mid-ride.

### "Downloading" gets a shape, not a colour

A fourth region-boundary colour was attempted properly and does not exist. A sweep of the whole
RGB cube for a colour at C ≥ 46 clearing ΔE 16 from both basemap palettes, the three existing
boundary colours *and* the six route colours returns **nothing**. Between them they have used up
the usable circle — the same wall `profiles.ts` records hitting.

So a region in flight keeps the `available` blue and separates on a **dashed outline**, exactly
as the basemap's path kinds separate on dash pattern at held chroma. Shape needs no clearance
rule and survives dichromacy.

Related: the unselected fill dropped from 0.18 to 0.06. Alpha compounds, and with fourteen
overlapping boxes a fill that reads correctly alone came out as a wash of blue with the
coastline barely visible under it. Fill is now reserved for the three states where it means
something — selected, downloading, installed.

## The bug this phase found, and what it cost

**A cancel could overtake the start it was cancelling.** `EngineClient.cancelRegionDownload`
deliberately skipped `await this.init()` — there is nothing to cancel in a Worker that has not
started — so it posted its Comlink message *immediately*, while `downloadRegion` posted its own
only after awaiting an already-resolved `ready`. A Stop issued in the same tick as a start —
which is exactly what happens when the queue pumps the next job and the rider stops it — arrived
first, found no controller registered for that id, and did nothing.

Measured in the browser: two regions queued, both Stops clicked, both rows gone from the screen,
and **166 MB downloaded to completion** for a region the rider had cancelled. It committed to
`regions.json`, so it also silently satisfied `readyToRide` and dismissed the first-run screen.

The fix is one `await this.init()` in the cancel path, guarded by an early return when no Worker
exists. Awaits on one promise resume in the order they were made, so the start is always posted
first and the cancel always finds it. Re-tested with the same same-tick double Stop: the running
archive froze at 102 MB and the queued region never started at all.

## Numbers

- **551 unit tests green**, up from 500; `composite.test.ts` (11), `downloadQueue.test.ts` (23)
  and `libraryModel.test.ts` (17) are new, `archiveChoice.test.ts` rewritten for `mountPlan`.
- **Two overlapping archives** cut from `edinburgh.pmtiles` (26 MB west, 19 MB east, sharing
  −3.30 to −3.10) mounted together. Flying to −2.72 (Morham, east-only) and −3.59 (Cockleroy,
  west-only) both render fully; deleting the east archive leaves −2.72 blank and −3.59 intact.
- **Resume after cancel works**: Central Scotland stopped at 102 of 109 MB of basemap, re-tapped,
  reported 133 MB of 141 MB and finished in about a second.
- Roughly **400 MB** of mirror egress across the whole verification session.

## The Setup screen, after the fact

Adding a library to Setup made it obvious that Setup did not look like the rest of the app, so
it got its own pass. The cause was not taste — it was two design systems in one binary. The ride
screen has a specific vocabulary (one hueless slate ramp, inset hairlines, no shadows, dense
0.76–0.95rem type, tabular numerals, rows at 2.9rem) and Setup was rendering browser defaults
next to it: 17px prose, `<dl>` with a 9rem label column, `<table>`s on the page background,
bare `<button>`s at a radius nothing else in the app uses.

The worst of it was a class that did not exist. `RiderPanel` marked its three explanatory
paragraphs `.step-note`, no stylesheet ever defined it, and so the prose rendered at full body
size and outweighed every heading on the screen. A dead class name fails silently and reads as
a spacing problem.

What changed:

- **A setting is a row.** `.setup-group` holds `.setup-row`s — label left, value right, note
  under — with dividers inset from the left so a group reads as one object rather than a stack
  of cards. Explanation moved *below* what it explains, in the muted size.
- **The tabs became one control**, a track with a sliding indicator, and they stay pinned under
  the header. Switching tabs after scrolling no longer means scrolling back up.
- **The emphasis is spent once**: the rider power preview. Three large tabular figures that move
  as the settings above them change are the only thing on the screen asking to be looked at, and
  they are the thing that makes "CdA 0.40" falsifiable against experience.
- The header stopped saying "Welcome" on tabs that are not Maps, went from 92% to 97% opaque
  (the blur alone does not defeat text at its own size scrolling under it), and links stopped
  being browser blue — the one colour on the screen nobody had chosen, in a palette whose whole
  point is that the route line is the only thing with a hue.
- `.picker-plain` gained an explicit `box-shadow: none`. `App.css` gives every `button` a
  hairline ring, and a class that clears `border` and `background` but not `box-shadow` left
  every quiet text button outlined.

## What is not done

- **Never ridden, never on a physical iPhone.** Two WebGL contexts at once is the new cost and
  the one most likely to bite an older phone; the acceptance test (airplane mode, cold launch,
  plan, follow) has not been run.
- **The price of a resumed download overstates.** After a cancel, re-opening a region quotes the
  whole region — `downloadPlan` counts a partially-fetched item in full, because it cannot know
  the resume will succeed. It overstates rather than understates, which is the right direction,
  but a rider who cancelled at 90% is told it costs 141 MB to finish.
- **No cap on mounted archives.** Every installed region is drawn. Fourteen would be fourteen
  sources and ~280 layers. The TileJSON `bounds` on each source means out-of-view archives fetch
  nothing, so the cost is per-layer bookkeeping rather than tiles — but it has not been measured
  past two.
- **Update All is fire-and-forget.** It enqueues every stale region at once with no combined
  price shown before the tap.
