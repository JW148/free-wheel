# Phase 6 — region downloads

**Status: built and unit-tested, never run against a live mirror.** Tap a region on a map of
Britain, watch it download, land on the ride screen with local data — that path exists in code,
compiles clean, and is exercised end to end by 310 tests. None of it has been exercised in a
browser, because the bucket it streams from does not exist. That gap, and the one below it, are
the most important facts in this document; see "What is not done" before reading anything else
as a success.

This phase replaces "download two files by hand from brouter.de and import them through the
Files app" with a picker: a streamed map of Britain, drawn from a small always-available PMTiles
archive, with tappable region outlines. Choosing one downloads a basemap extract and the BRouter
segments it needs from our own mirror, not from brouter.de directly.

## What was built

```
web/tools/mirror/
  lib/geometry.mjs        segment-grid math, cross-checked against the app's own tiles.ts
  lib/decide.mjs          hashOf, decideSegmentAction — the identical-bytes publish rule
  lib/manifest.mjs        buildManifest, assertPublishable
  lib/bootstrap.mjs       publishing on a bucket that has nothing on it yet
  s3.mjs                  the S3 calls, and the two cache-control policies
  sync-segments.mjs       the weekly job: brouter.de -> the bucket, by hash
  cut-basemaps.mjs        the monthly job: Protomaps -> region archives + the picker backdrop
  README.md               bucket layout, CORS, cron, and the order the two jobs must run in
  regions.json            the 14-region list, cut to a byte budget
web/src/data/
  regions.ts              regionState and downloadPlan — what a region costs, and if it is stale
  manifest.ts             DataManifest, RegionEntry, InstalledRegion, loadManifest (localStorage cache)
  origin.ts               DATA_ORIGIN, MANIFEST_URL, assetUrl — see "What is not done"
web/src/engine/
  downloads.ts            resumable, streamed, length-checked writes into OPFS (Task 8)
  partials.ts             the durable "this file is mid-download" marker (Tasks 9, 9b)
  regionStore.ts          region install records, the download loop, the Worker-side API
web/src/setup/
  pickerModel.ts          everything the picker decides that doesn't need a browser
  RegionPicker.tsx        the screen itself
  regionLayers.ts         region outlines as a MapLibre GeoJSON source + fill/line layers
```

`web/src/ride/useMapLibre.ts` gained the ability to lend its one MapLibre instance to the picker
(`showRemote`/`endRemote`) rather than the picker owning a second map — OPFS and MapLibre's own
worker pool both make a second instance expensive, and Task 12 found out the hard way what goes
wrong when a screen believes it owns a map it is only borrowing (below).

## What was measured

Protomaps build `20260906`, `--maxzoom=14`, one basemap archive per region:

| region | archive size |
|---|---|
| Britain, z0–10 (the picker's own backdrop) | 61 MB, measured |
| Central Belt (probe, not shipped) | 86 MB, measured |
| London (probe, not shipped) | 54 MB, measured |
| South West England | 102 MB, measured |
| The Midlands | 180 MB, measured |
| Southern Scotland and the Borders | **≈ 110 MB, estimated** (49 MB measured at a smaller extent) |
| London and the Home Counties | **≈ 155 MB, estimated** (128 MB measured at a smaller extent) |

**Two of those figures are no longer measurements.** Closing the coverage holes (below) widened
six regions — `highlands-islands`, `central-scotland`, `southern-scotland`, `east-anglia`,
`wessex` and `london-home-counties` — and an archive's size follows its bbox. Re-measuring needs
`pmtiles extract` against a dated Protomaps build, so the two that had a measurement are scaled
from it by area instead: Southern Scotland gains 1.97 deg², including Edinburgh and the Forth,
and London gains 0.72 deg² of semi-rural Essex. The other four were never measured at all. Every
one of these is settled for real by the first `mirror:basemaps` run, which prints exact bytes per
region — **check them against the 250 MB threshold then**, because that claim is now an estimate
for six of the fourteen.

London's 54 MB probe against the Central Belt's 86 MB, both roughly city-sized, is a 168 MB
per square degree vs. 37 MB per square degree difference — city density costs far more per unit
area than rural coverage, which is why the regions are cut on a byte budget rather than on
equal-looking map area. Nothing needed splitting on bytes in the end. The two that did need
splitting needed it for a different reason — see below.

**First-download time on a phone was not measured.** There is no bucket to download from, so
there is nothing to time. This is the single biggest hole in "what was measured" and it stays
open until the first upload runs.

## Where the plan turned out to be wrong

### The region list's own bboxes broke the region list's own test

Task 2's brief supplied fourteen region bboxes verbatim. Two of them —
`southern-scotland` and `south-west-england` — sat exactly on both a longitude and a latitude
line of BRouter's 5°×5° segment grid, so each needed four segments rather than the ≤2 the
brief's own test demanded. Mechanically splitting each region at the line it straddled "fixed"
the test but made the geography worse: one split pulled in a Brittany segment for a Cornwall
ride, the other was a 0.3°-wide sliver that existed only to justify an Irish-quadrant segment
and a Highlands one neither region wanted. The real fix was to nudge the offending edges off the
grid lines (south-west England's southern edge from 49.9° to 50.0°, southern Scotland's western
edge from −5.3° to −5.0°) rather than cut at them. Final count: **14 regions**, all ≤2 segments.

### And then the bboxes left six holes, with real towns in them

The test that was supposed to catch that named eleven cities and asserted each fell in some
region. None of the eleven landed in a hole, so it passed — while Oxford, Cheltenham,
Gloucester, Cirencester, Stroud, Witney, Bicester and Abingdon sat in a band between Wessex's
north edge at 51.6, the Midlands' south edge at 52.0 and South West England's east edge at
−2.4, and Aberdeen and Stonehaven sat east of the Highlands' −2.4. A friend in Oxford would
have opened the picker with nothing to tap.

Sweeping properly — a 2 km grid over a hand-traced outline of mainland Britain, in
`lib/regions.test.mjs` — found four more holes: Berwick-upon-Tweed and the Berwickshire coast,
the Lincolnshire coast from Skegness to Grimsby, north Essex around Colchester, and the whole
of Kintyre. The named-cities test could not have found any of them; the holes a list of
rectangles leaves are between the places anyone thinks to name.

All six are closed by widening a bbox, and every region still needs at most two segments, from
the same five grid cells as before. Two of the closures are worth recording:

- **Kintyre** took `central-scotland` from one segment to two. That is only tolerable because
  the second is `W10_N55` at **5.5 MB** — by far the cheapest cell on the grid, being almost
  all sea. The region gained Arran, Bute, Islay and Jura with it, and is renamed *Central
  Scotland and Argyll*. `east-anglia` likewise becomes *East Anglia and Lincolnshire*.
- **Orkney** came in free: the Highlands' north edge moved from 58.7 to 59.5, still inside the
  same `N55` row of the grid.

Three accepted gaps remain, each one a bbox edge sitting on a grid line where the next nudge
outward costs a whole extra segment:

- **the Lizard tip and the Isles of Scilly**, below 50.0°N — the next row down is `W5_N45` and
  `W10_N45`, Brittany and the Bay of Biscay.
- **the Rhins of Galloway** (Stranraer, Portpatrick), west of −5.0 — reaching them takes
  `southern-scotland` from two segments to four.
- **Shetland**, above 59.5°N — `W5_N60` would be a third segment for the Highlands.

The first two are declared in `regions.test.mjs`, which asserts both that no other mainland
point is uncovered *and* that each declared gap is still real, so closing one without deleting
its declaration fails the build. Shetland is not on the mainland, so the sweep never reaches
it; it is recorded here and nowhere else.

### Task 1's geometry had the same clamp bug in two places, on purpose, and it was wrong in both

The mirror's `geometry.mjs` is deliberately a from-scratch reimplementation of the app's
`tiles.ts`, cross-checked by a shared test corpus rather than shared code — so the bucket and
the phone can never silently disagree about which segments a bbox needs. The plan's own
reference snippet clamped high latitudes to N80 instead of skipping them, had no S90 guard, and
no antimeridian split, and the cross-check test's own boundary cases didn't reach far enough
north to catch it. Fixed by porting the app's guards into the mirror script instead of writing
a narrower test around the bug.

### A null hash must never reach a bucket object's name

`decideSegmentAction` was reviewed twice for the same class of defect: a non-304 upstream
response with no hash (an unexpected shape from brouter.de) falling through to "publish" and
naming a bucket object `W5_N50-null.rd5`. Once for segments (Task 3), once for `buildManifest`
guarding `region.basemap` the same way (Task 4) — the guard had been applied narrowly the first
time and needed to be symmetric. Both now throw loudly. The cron has a log and can afford to
skip a week; every client reading a null-named object could not.

### The Worker has no `localStorage`, and the manifest module now does

`engineApi.ts` runs in a Worker. `manifest.ts`'s `loadManifest` reads `localStorage` to cache
the manifest for offline use — fine on the main thread, fatal if it ever got pulled into the
Worker bundle. The fix is `import type` everywhere the Worker touches manifest types, so nothing
that touches `localStorage` is reachable from tree-shaking's perspective.

### The download marker: designed once, corrected five times, corrected again

This is the deepest rabbit hole of the phase, in `web/src/engine/partials.ts` and
`regionStore.ts`'s download loop. The mechanism exists because a region download can be
interrupted mid-file, and an interrupted `.rd5` sitting at the real path must not look installed
— to BRouter, to the tiles panel, or to a resumed download reading a stale hash.

The initial review found three Important defects at once:

1. An aborted download left a registered, size-0 file that both BRouter and the tiles panel
   treated as real.
2. Two overlapping `downloadRegion` calls could each snapshot and overwrite `regions.json`,
   silently dropping a region — the shared-segment guarantee the whole task exists for.
3. `removeRegion` deleted files before writing records, so a partial OPFS failure left a region
   recorded but unopenable with no way out short of resetting storage.

Fixing those, plus lifting the whole download loop into `regionStore` so it could be tested at
all, took five further review rounds, each closing what the last one opened one layer down: a
stale `/downloads.json` entry that hid a complete, hand-imported segment as unroutable; the
same entry's in-memory twin, `targetSize`, never cleared on the import path; a whole
`isPending` mechanism that shipped with its logic inverted and no test able to tell; and finally,
worst of the run — the marker was written *before* the file was opened, truncated and
registered, so a fetch failing before its first byte either re-exposed a truncated orphan or (once
the mark moved later to fix that) left a permanently-listed 0-byte segment. Moving the mark later
still left one gap: it was written before an *awaited, throwable* `openSink` with nothing to roll
it back, so a failed open recorded the **new** hash against the **old** file's bytes, and a retry
saw hash-match-plus-short-length and resumed — appending the new download's tail onto the old
file's prefix. The length check passed. BRouter would have routed on a spliced segment, exactly
the corruption `resumeDecision`'s hash comparison exists to prevent.

That last finding was real and load-bearing enough that it went to a separate task (9b) rather
than a sixth round on the same loop: the marker gained a `started` field, written `false` before
the sink opens (hiding the file immediately) and flipped to `true` only after the truncate
succeeds. `resumeDecision` now refuses both `resume` and `done` for anything not started, because
an unstarted marker's hash describes the *fetch being attempted*, never the bytes on disk — a
coincidentally-matching length does not mean a finished download. The fix is deliberately
conservative: a failed open now hides a good file until the next retry restarts it cleanly,
trading one wasted re-download for the corruption it used to permit.

The pending-marker design itself — rather than a simpler stage-then-`FileSystemFileHandle.move()`
scheme, which would delete the whole mechanism because a partial file would never exist at the
real path — was kept rather than rewritten. Not because it's the better design in the abstract,
but because it had already been through three rounds of scrutiny and `move()` support on iOS
Safari's OPFS is unverified. Recorded for Phase 7 rather than decided now.

### The picker and the ride screen share one map, and for four rounds that was unsafe

Task 12 (the screen itself) took five review rounds after its initial review, all on the same
structural question: `RegionPicker` deliberately draws over `RideView`'s live MapLibre instance
rather than mounting a second one (a second instance means a second OPFS/MapLibre-worker
footprint), which means the picker is *borrowing* a map the ride screen still, in some sense,
owns. The initial review's Critical was the one that blocked everything else from mattering:
the picker's region taps passed through to `RideView`'s own map click handler, because hiding
`.ride-chrome` stops taps reaching buttons but not the map underneath — tapping a region stamped
a waypoint on Britain and persisted it to `localStorage`. Fixed with a prop threaded through
`App` so `RideView` suppresses its own tap handling while the picker is up.

Every round after that fixed what the previous one had found and surfaced the next adjacent
hole:

- **Round 1** fixed the Critical and its accompanying Important, and found: standing down from
  the picker left the ride screen showing the streamed Britain backdrop instead of handing the
  map back.
- **Round 2** fixed that, and found: the gate reopened one effect flush before the handback
  actually completed.
- **Round 3** fixed that, and found: `endRemote` could return successfully with the loan still
  open when `refresh()` answered null, and `leave()` proceeded regardless — the ride screen
  believed it had its map back when it did not.
- **Round 4** went to a fresh implementer, per the escalation protocol, since three rounds in a
  row had each closed one hole and opened the next one adjacent to it. It fixed round 3's
  finding and found two more: a cancelled loan reported from its own catch arm, and one route to
  the failure screen that skipped the closing guarantee the other routes had just earned.
- **Round 5** fixed both, cleanly — the review that closed the task.

The structural property the task spent four rounds failing to hold — that the loan is closed in
exactly one place, no matter which exit is taken — is now held by construction: `discardMap` is
the only function that clears the map refs, `endRemote` states the contract by name, and every
caller depends on it rather than repeating the teardown. The one crack in that guarantee found
after Task 12 closed — `discardMap('unavailable')` inheriting its `error` status from whoever
called it, rather than asserting it — is the carried-over one-line fix this task made in
`useMapLibre.ts`, committed separately from the documentation changes.

## The browser verification checklist

Nothing in the picker has ever run in a browser, because `DATA_ORIGIN` names a bucket that does
not exist. Task 12's report built up an ordered walkthrough across its five fix rounds; the
workspace it lived in is deleted after this task, so it is reproduced here rather than lost.
Run it in order once the mirror is live — later items depend on earlier ones holding.

1. `curl -sI "$MANIFEST_URL" | head -1` returns `200`, and the body parses through
   `parseManifest`. Nothing below is meaningful until it does.
2. Cold start, storage cleared, private window. The app opens on the picker, not the ride
   screen.
3. The backdrop draws: `showRemote` mounts `manifest.picker.url` over HTTP range, Britain
   appears at zoom 4.6. If it does not, check the Network panel for range requests against the
   picker archive before suspecting the style — a dead MapLibre worker looks identical (see
   `CLAUDE.md` on the worker entry point).
4. Region outlines appear, in the three `REGION_COLOURS` — proof `ensureRegionLayers` ran after
   `styleReady` rather than before.
5. A tap on a region selects it: the outline thickens, the sheet names it and states size in MB
   above the button. Tap two regions in a row — the waypoint-leak bug (round 1, above) needed
   two taps to be obvious.
6. The attribution is visible and not hidden behind the sheet, in both the list state and the
   detail state.
7. A tap in the gap between the head and the sheet pans the map and does nothing else — must
   not reach the ride screen's control rail or action bar.
8. Download: the bar advances to 100%, the line names "the map" then "the road data", then
   "Finishing up…", then the ride screen opens on that region's own archive.
9. Reload: straight to the ride screen, no picker, no region outlines anywhere on its map.
10. Throttle to offline mid-download, then Retry: the transfer resumes with a `Range` header on
    the retried request, and the bar jumps to the resume offset rather than restarting at 0. If
    it restarts at 0 instead, the bucket's CORS rule is missing
    `Access-Control-Expose-Headers: Content-Range` — the downloader cannot place a `206` whose
    range it cannot read, so it deliberately re-fetches the whole file rather than guess.
11. Reload with the network off, having downloaded once: the head shows the saved-list note, and
    any installed region reads `unknown`, not `current`.
12. Clear `localStorage` only, go offline, reload: the "no list of regions" sheet appears, and
    "Set up by hand" opens Setup *over* the picker rather than behind it.
13. Home-screen app, iPhone, `(display-mode: standalone)`: the bottom of the sheet paints —
    measure in pixels, not `getBoundingClientRect()` (see `CLAUDE.md` on `100lvh`).

Additional checks the fix rounds surfaced, folded in at the point they apply:

- **After 5:** check `localStorage` for `free-wheel`'s plan key being written — it must not be,
  on a picker tap.
- **After 9:** confirm no region outlines survive a reload straight to the ride screen.
- **Around 8/12, the hand-import escape hatch, four separate walkthroughs:** from the no-list
  state, open Setup, import a basemap and road data by hand, press Done — the picker must stand
  itself down and the ride screen's map must carry no region boxes. Do the same importing only
  road data, and separately only a basemap, each time confirming the rider lands on the **local**
  archive, not on Britain at zoom 4.6, and that a route still plans and the theme button still
  works (both were found silently dead in earlier rounds). With waypoints already on the map
  before the picker appeared, confirm the S and F pins are present, tappable and draggable after
  the exit — a route line with no pins on it is the marker fault. With a route already planned,
  confirm the camera fits the route rather than sitting at the archive's own centre.
- **"Carry on without a region" on an empty phone:** the map must tear down to the `no-basemap`
  state with "No map on this phone yet" on the rail — not left showing a streamed Britain.
  Double-tap it: one handback, no flicker of two maps, "Opening your map…" shown in between.
- **Force a storage fault:** serve over plain HTTP on the LAN so `navigator.storage` is
  `undefined` (per `CLAUDE.md`). The headline must be the storage fault, not "could not reach
  the internet".
- **Force an engine fault with a loan open:** picker up, Britain streaming, open a second Safari
  tab on the same origin to collide the OPFS handles (or block the Wasm fetch), then hand-import
  and press Done. Britain must disappear, the picker must stay up with a tidied explanation and
  two buttons, and it must never reach the ride screen wearing Britain as its backdrop. Close
  the second tab, press Try again: it must actually retry, not repeat the same stale fault.
  From the fault, press Carry on anyway: the ride screen must open with no map and the engine's
  own message on the rail, not "No map on this phone yet" (the wrong fault's copy).
- **Slow-mirror cancellation:** throttle to "Slow 3G", make the picker archive fail after the
  request starts, and take "Set up by hand instead" while it's in flight. After landing on the
  local archive, no red alert banner may appear seconds later quoting the picker archive's URL —
  this is `loanGeneration`, and as of this task it has still never run.

Items 2, 5, 7, 8, 10, 12 and 13 above have no automated test behind them at all; they depend
entirely on this walkthrough.

## What is not done

**The bucket does not exist.** The scripts that fill it do: `web/tools/mirror/s3.mjs`,
`sync-segments.mjs`, `cut-basemaps.mjs`, `lib/bootstrap.mjs` and `README.md` are all written,
`npm run mirror:segments` and `mirror:basemaps` are wired into `web/package.json`, and every
pure function they call — `hashOf`, `decideSegmentAction`, `buildManifest`, `assertPublishable`,
`partitionByReadiness`, `carryForwardBasemaps`, `segmentsForBbox`, `regions.json` — has tests.

What has never happened is the **first upload and the CORS check against a live bucket**. That
needs Hetzner Object Storage credentials nobody here has, and it publishes to an external
service, which is a decision for whoever holds those credentials rather than something to do
speculatively. Neither script has been run at all, so nothing below the S3 client's first call
has ever executed: read `web/tools/mirror/README.md`'s "Ordering" section before the first run,
because the two jobs have to go in one particular order on an empty bucket.

Consequently:

- `web/src/data/origin.ts`'s `DATA_ORIGIN` is a placeholder in Hetzner's endpoint-URL form,
  `https://free-wheel.fsn1.your-objectstorage.com` — a guess at the shape the real host will
  take, not a working address. **There is no bucket public URL to record here.** Replace the
  constant once the first upload succeeds, and confirm with `curl -sI "$MANIFEST_URL" | head -1`
  expecting `HTTP/2 200`.
- The VPS cron is written down (two lines, in `README.md`) but not installed anywhere. It
  needs five environment variables the app itself never uses, because the app has none:
  `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- **Nothing in `RegionPicker` has ever run in a browser**, for the same reason — there is
  nothing to stream from. Every line above in "the browser verification checklist" is unrun.
- **The on-device acceptance test — cold launch, tap a region, airplane mode, plan and follow —
  has not been attempted**, and could not have been: it needs both a live bucket and a physical
  iPhone, neither in reach of this task. This remains the actual bar for calling Phase 6 done,
  unchanged from every earlier phase's acceptance test.

## Deferred to Phase 7, by the plan's own design

- Restructuring Setup into Regions / Preferences / About / Advanced.
- The Diagnostics gesture.
- Deleting `TilesPanel`'s size estimator and `npm run build-catalogue`, both superseded by the
  manifest's own byte counts.
- The `.setup-header` colour token.

## Verified

- `cd web && npx vitest run` — 310 passing across 22 files (baseline before this phase: 98
  across 8; the mirror's pure logic and scripts, the manifest parser, the resumable downloader,
  the partial marker, `regionStore`, the picker's model, and the region-outline layer account
  for the rest).
- `npm run build` — clean, `tsc -b` and `vite build` both succeed, service worker precache
  unaffected.
- **Not verified: anything that needs a browser, a network, or a bucket.** See "What is not
  done" above. Desktop Safari and the Simulator both diverge from real devices on storage, per
  `CLAUDE.md`, so even once the bucket exists this phase still ends on a physical iPhone, not a
  desk.
