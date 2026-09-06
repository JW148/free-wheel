# Phase 4 — the ride UI

**Status: plan-and-follow works end to end.** Tap waypoints, pick a profile, route on-device,
see the line, follow with a live position and a screen wake lock. Verified on desktop against
real Edinburgh data; verified to boot and initialise on the iOS 26.5 Simulator. **Not yet
verified on a physical iPhone**, which remains the acceptance bar.

The app was, until this phase, the Spike 1 harness with panels bolted on. It is now an app:
`RideView` is the whole screen, and every diagnostic moved behind Setup.

## What was built

```
web/src/ride/
  RideView.tsx      full-bleed map, stats rail, floating controls
  RouteSheet.tsx    the action bar and the panel it opens into
  useMapLibre.ts    owns the Map and the mounted PMTiles archive
  useRoute.ts       waypoints, the engine call, localStorage persistence
  useGeolocation.ts watchPosition, with the permission states separated out
  useWakeLock.ts    screen wake lock, reacquired on visibilitychange
  routeLayers.ts    route line and position dot as GeoJSON sources
  gpx.ts            BRouter GPX -> coords + distance/ascent/time
web/src/setup/
  SetupView.tsx     overlay: Maps and data | Diagnostics
  DiagnosticsPanel.tsx
```

`MapPanel.tsx` is gone; its map became `useMapLibre`, its import controls became
`map/BasemapPanel.tsx`, and its diagnostics became `setup/DiagnosticsPanel.tsx`.

## Decisions worth keeping

### GPX is parsed, not re-exported as GeoJSON

`brouter-core` has `FormatJson`, which would hand back GeoJSON and skip the parsing entirely.
It is deliberately not used. Using it means a second output format out of `Router.java`, and
**the GPX corpus is the regression net** — every route the app draws now goes through the same
`FormatGpx` output that is checked byte-for-byte against the JVM. Parity therefore covers what
the user actually sees, by construction rather than by coincidence.

`gpx.ts` is regex-based rather than DOMParser-based: the input is only ever `FormatGpx`'s own
output, it must run in a Worker, and building a 5,000-node document for a 76 km route to throw
it away immediately is wasteful. The fixtures under `src/ride/__fixtures__/` are verbatim
`./gradlew jvmRoutes` output so that the coupling to `FormatGpx` breaks loudly.

BRouter's summary line carries everything the stats rail shows:

```
<!-- track-length = 1964 filtered ascend = 1 plain-ascend = -2 cost=2975 energy=.0kwh time=5m 23s -->
```

Note `time=` is **absent** when the profile has no energy model (`shortest.brf`). `timeS` is
`null` in that case rather than `0`, because rendering "0 min" would be a lie.

### Everything is one screen, and Setup is an overlay

Setup does not replace the ride screen — it covers it. Unmounting the map would drop its OPFS
handles and its whole tile cache, and rebuilding both to show an import button is absurd. The
map controller therefore lives in `App.tsx`, since Setup needs it too (importing a basemap
switches to it).

### `100dvh`, not `inset: 0`

In Safari proper the bottom toolbar overlaps a viewport-height fixed element, which buried the
action bar. `dvh` tracks the chrome as it collapses; in a home-screen app the two are
identical.

## Corrections to earlier docs

**The Protomaps demo bucket is gone.** `https://demo-bucket.protomaps.com/v4.pmtiles`, recorded
in `HANDOFF.md` and `docs/phase-3-progress.md`, now returns 404. The live source is the dated
daily build:

```bash
~/bin/pmtiles extract https://build.protomaps.com/20260906.pmtiles data/basemap/edinburgh.pmtiles \
  --bbox=-3.85,55.65,-2.55,56.20 --maxzoom=14
```

These expire — `20260801` already 404s. Use a recent date.

**`web/public/engine/` and `web/public/profiles2/` are now committed.** They were gitignored as
generated output, which is true but incompatible with deploying from git: building them needs
JDK 21, Gradle, and the `brouter-link` symlink to a separate local checkout, none of which
exist on a static host's build machine. Only the `-PwasmDebug` sidecars stay ignored.

## The bug the offline test caught

Worth recording, because it was invisible to every other check and it sat exactly on the
ride-day path.

Moving `TilesPanel` behind Setup broke cold-start routing. **`installedTiles()` is what opens
the `.rd5` sync access handles and registers `/segments4` with the VFS**, and it used to run on
every page load purely because `TilesPanel` mounted at the top level. Once it only mounted when
Setup was opened, a cold start that went straight to routing opened nothing, and BRouter failed
with:

```
segment directory /segments4 does not exist
```

— while the tile sat in OPFS, plainly there. Two separate reasons it has to happen at init:
reads are synchronous, so a handle can never be opened lazily during a read; and the VFS's
directory registry is in-memory, built as files are opened, so an unopened directory does not
exist as far as BRouter is concerned.

The scenario is the obvious one in hindsight: plan a route at home, close the app, reopen it on
the bike, tap Reroute, fail. It survived the desktop pass only because every route there was
run in the same session as the import. `engineApi.init()` now calls `installedTiles()` itself —
**the engine must not depend on a React component having mounted.**

The general lesson: a cold start is a different code path from a reload with warm state, and
only an offline test with a killed server forces you down it.

## Verified

On desktop, against `edinburgh.pmtiles` (34 MB) and `W5_N55.rd5` (26 MB) in OPFS:

- Basemap renders; switching archives rebuilds the map cleanly.
- Two taps place S and F pins; routing returns in well under a second.
- Edinburgh → Dalkeith, trekking: **12.3 km, 40 min, 98 m climbing**, matching the GPX header
  (`track-length = 12252 filtered ascend = 98 ... time=39m 37s`) exactly.
- Route, waypoints and profile survive a cold reload via localStorage.
- No console errors at any point.
- **Offline, with the dev server killed and `fetch` confirmed to throw**: the app cold-loads
  from the service worker precache and routes. Switching trekking → gravel returned 12.9 km /
  117 m against trekking's 12.3 km / 98 m, and `brouter_gravel_0` — a different answer, so a
  genuine on-device computation rather than a cached one.
- `gpx.ts`: 20 unit tests, run with `npx vitest run`.
- The JVM corpus regenerated clean: **9/9 routes**, engine untouched this phase.

On the iOS 26.5 Simulator (iPhone 17 Pro, Safari, `http://localhost:4174`):

- The app boots and reaches the "Import a map to begin" empty state.
- **That state is only reachable after `init()` resolves**, which means the WasmGC engine
  loaded, the profiles were provisioned into OPFS, and the VFS installed — on real iOS WebKit.
- `http://localhost` is a secure context, so the Simulator reaches the Mac's dev server
  without the HTTPS dance a physical device needs.

### Profiles are precached now

`globPatterns` gained `brf` and `dat`. The profiles normally reach OPFS via `provisionOpfs` on
first init, which fetches them — fine, because the first launch is online. The failure mode this
closes is the second one: WebKit evicts OPFS under storage pressure, and without a precached
copy the profiles cannot be restored offline, so routing dies mid-ride with no way back.
144 kB for that is cheap. Precache is now 40 entries, 5.0 MB.

## Round two: acting on ride feedback

The first build was ridden-adjacent, not rideable. What came back, and what changed.

### The map was torn — and it was our style, not the data

Wide blue slabs across the basemap, on desktop as well as iOS. Decoding tile `14/8045/5107`
directly settled it:

```
water: LineString kind=canal x1, LineString kind=stream x1, Polygon kind=water x2
```

Protomaps ships **linear water in the same source-layer as areal water**, and MapLibre's fill
bucket closes a LineString into a ring and fills it. The Union Canal was being painted as a
lake. London was affected too — the Thames is a real polygon, which masked it.

Every fill layer now filters to `Polygon`, not just `water`: `landuse` and `landcover` carry
linear features elsewhere. Linear water returns as a `line` layer rather than being dropped,
because a canal towpath is worth riding on. `style.test.ts` asserts the guard so a new fill
layer cannot reintroduce it.

### Dark by default, light one tap away

The chrome went from an opaque bezel to translucent panels floating over a full-bleed map.
The map is the content; framing it wasted screen and read as a web page rather than an app.

Both palettes exist because the trade-off is real: dark recedes behind the route and suits
dusk and OLED, but a dark map in direct sunlight loses to glare. The *map* switches; the UI
around it does not. Having two notions of "theme" was what produced a white button with white
text on the dark setup screen, so the chrome tokens are now unconditionally dark.

### Elevation and comparison, from data already in hand

BRouter returns a `<ele>` per track point and the app was discarding it. The x-axis is summed
from coordinates; extremes come from every point rather than the downsampled ones, since the
summit is usually a point sampling dropped.

Comparison routes several profiles sequentially — the Worker blocks inside Wasm, so parallel
issuing would queue anyway and lose the per-profile progress. Colours are fixed per profile
and never cycled: adding a fourth must not repaint the other three. The palette was run
through a CVD validator against the dark surface (worst adjacent pair ΔE 11.5 deuteranopia,
24.4 normal), and rows carry a label and swatch so identity is never colour alone.

### Cycle-specific tiles: not possible as originally done

The dissertation app used an online raster cycle-tile provider. That is fundamentally
incompatible with offline-first — there is no archive to import and no legal bulk cache. The
achievable version is styling the Protomaps vector data to emphasise cycleways and surface,
which is deferred, not blocked.

### A second concurrency bug

The startup check and the map controller now both ask the engine what is installed at boot.
Two concurrent `openHandle` calls for one path both reached `createSyncAccessHandle()`, the
second threw, and a fully provisioned app reported having no data. `openHandle` now returns
the in-flight promise per path. Note this is the same constraint that makes **two Safari tabs**
fatal — that one the app cannot fix, only report better.

## Not verified, and why

- **Anything past the empty state on the Simulator.** Getting a 34 MB archive through the
  Files picker in a Simulator is not scriptable, and the acceptance test is a physical iPhone
  anyway.
- **Follow mode against a moving fix.** `simctl location set` puts a fix at Edinburgh, but
  exercising it needs the data imported first.
- **Wake lock.** Needs a home-screen PWA on real iOS 18.4+; the code reports its own
  availability, so a failure is visible rather than silent.
- **Peak memory during routing**, still never measured. The plan wants it under ~300 MB.

## Deliberately out of scope

Turn-by-turn, off-route alerts, dragging the *line* to reshape (dragging a *pin* works),
elevation profile, and search or geocoding — there is no offline geocoder, and adding one is
a much bigger piece of work than it sounds. Background tracking is not merely out of scope but
unachievable: iOS suspends a backgrounded web app's timers and geolocation within seconds.

## Choosing between compared routes

Comparing several profiles worked; deciding between them did not. The elevation profile
described whichever route `focused` happened to name, and `focused` was seeded with
`'trekking'` and could never be empty — so after a three-way comparison the graph was showing
one of three routes with nothing on screen saying which, and Start would ride it.

The fix is one state change with everything else following from it: **`chosen` is nullable**
(`plan.ts`, storage version 3). `null` means "compared, not yet decided", a state the old
model could not represent.

- **Choosing** is a tap on a route line on the map, or on a row's figures in the sheet. Both
  go through `chooseProfile`. A run returning a single route commits automatically — there is
  nothing to weigh it against.
- **Ticking a profile no longer chooses it.** The old row was one `<label>` with an `onClick`,
  so a tap meant as "show me this one" also flipped the checkbox under it. Rows now have two
  targets: the text ticks, the figures choose.
- **The drawer has two views**, not two drawers. *Compare* is the list; *detail* is one route
  with its figures, its elevation profile and Ride this. Opening the drawer lands on whichever
  the plan makes useful, which is what keeps the single-profile case unchanged.
- **The elevation profile takes `colour` and `label`**, so the graph is drawn in the same hue
  as its line on the map and its heading names it. That is the ambiguity closed at both ends.
- **Starting a ride draws only the chosen route**, as a lone route — neutral near-white, best
  contrast for a glance at speed. The rejected routes stay in state, so End ride restores the
  comparison.

Two numbers were tuned by looking rather than reasoning. An unchosen route at `line-opacity`
0.32 read as *gone* over the dark basemap rather than as quiet, which breaks changing your
mind; 0.45 recedes without disappearing. And route lines are 2.5–8px wide, nowhere near a
thumb, so `routeAt` searches outwards in rings (4, 11, 20px) — one fat radius would resolve an
exact tap on one of two parallel lines to whichever came back first.

All chrome over the map also went translucent (`--panel` 72%, `--panel-strong` 82% for the bar
and drawer, over a blur). The drawer was fully opaque before and changed the most; its overlay
dropped 55% → 35%, since dimming that hard was the only thing left hiding the map. The tokens
had to move from `.ride` to `:root` — vaul portals the drawer to `<body>`.

**Verified on desktop Chrome against real Edinburgh data** (33 MB basemap and `W5_N55.rd5`
seeded into OPFS): three profiles routed, tapping the green line chose Gravel and opened its
detail, the graph read "Elevation — Gravel" with a `#5a9e63` stroke, picking Trekking from the
list switched both, and Ride this left one near-white line on the map. Not yet ridden.

### Clearing a choice

Choosing was a one-way door: `chosen` could be set but never unset, so a comparison could be
entered and never returned to. `clearChoice` fixes that, reachable three ways — a **Clear
selection** button in the detail view, re-tapping the chosen row's figures in the compare list
(its chevron becomes a clear icon, because the affordance has to match what the tap does), and
a tap on empty map.

The map gesture needed a precedence rule, since a tap on empty map already places a waypoint.
`mapTapAction` owns it and is tested directly: **choose → clear → place**. Clearing beats
placing because the pin toggle is on by default, so the other order would leave the gesture
unreachable exactly when it is wanted; a via point that really was intended costs one more tap.
Verified end to end — the first empty-map tap cleared the choice and added nothing, the second
placed a point.

A lone route reports `clearableChoice: false` and is exempt from all of this. It is not a
comparison: there is no all-colours state to go back to, and clearing would only strip the
stats rail and disable Start.

## Comparing climbs, and route colours that survive the basemap

Two complaints from the first real use of the comparison, both about reading the map rather
than driving it.

### One chart, several routes

The list gave three ascent totals and nothing else. But 120 m spread evenly is a different
ride from 120 m in one wall, and the total is identical either way — the *shape* is what is
being compared, so the shapes now go on one pair of axes above the list.

`elevationComparison` in `elevation.ts` is the derivation, kept pure and tested separately
from the drawing. The axes are shared deliberately: a common distance axis means a shorter
route stops short of the right-hand edge instead of being stretched to fill it, and a common
height axis means a line that sits higher climbs more. Six charts each auto-scaled to
themselves would put the flattest route and the hilliest one in identically-sized boxes,
which is worse than no chart.

Lines only, no filled areas — several translucent fills stacked produce a colour at every
crossing that belongs to no route. The single-route chart keeps its fill because it has
nothing to muddle with. Below two plottable routes the component renders nothing and the
detail view's own chart is the better answer.

The legend doubles as a picker. Having read the chart, "that one" is the next thing you want
to say, and the nearest control should take it.

### The palette was a road colour

The muted palette was tuned against the dark basemap and measured badly against both:

| | old | new |
|---|---|---|
| worst route pair, normal vision | ΔE 13.9 | ΔE 26.4 |
| closest approach to any basemap colour | ΔE 7.5 | ΔE 18.0 |
| worst route pair under deuteranopia/protanopia | ΔE 0.1 | ΔE 8.3 |

`shortest` (`#7f9aa8`) was ΔE 7.5 from the light theme's boundary colour and 9.1 from the
dark theme's main roads. It was not a low-contrast road colour; it was a road colour — its
chroma, 12.1, sat inside the basemap's own range.

**The fix is chroma, not hue.** Every colour in both basemap palettes is C ≤ 15.1 — the map
is near-neutral by construction — so a line at C ≥ 45 cannot be read as map furniture
whatever its hue. That one constraint does more work than any amount of hue-picking. A
lightness floor of L\* 56 keeps anything from sinking into the dark basemap; the dark casing
already handles the light one.

Two things worth recording about the search:

- **No blue clears ΔE 20 against this basemap.** The best available is 19.9, because the
  slate theme spends blue-grey on water, roads and boundaries. The chroma gap is what
  actually separates them (C 50 against C 12) and CIEDE2000 compresses exactly that
  difference, so the ΔE understates it. The metric is the wrong instrument for vivid-against-
  neutral; it was used as a floor, not as the decision.
- **Six categorical colours cannot all separate under dichromacy.** A dichromat has roughly
  one usable hue axis, so past about three categories the separation has to come from
  lightness, and there is not enough to go round six. An optimiser told to maximise the
  worst CVD pair returned two greens and three orange-reds at ΔE 17.2 — better on the metric,
  unusable as a set. The palette here accepts ΔE 8.3 on its worst pair (violet against cyan,
  both collapsing towards blue) because identity is never colour alone: every row carries a
  label and a swatch, the chosen route is separated by width, and the detail view names it.

### The lone route was the worst case

A single route was drawn near-white (`#ccd0cf`) on the reasoning that hue is only for telling
routes apart. On the daylight basemap that is ΔE 4.4 from buildings and 7.3 from earth — so
the most common state in the app had its least visible line, and the rationale had never been
checked against the light theme.

Every route now takes its profile's colour, including a lone one. This removes a state rather
than adding one, and the map no longer repaints the moment a second profile is ticked.
`SOLO_ROUTE_COLOUR` is gone.
