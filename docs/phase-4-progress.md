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
