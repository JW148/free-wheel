# free-wheel

Offline cycle route planner for iOS, delivered as a PWA. It runs the **BRouter** routing
engine on-device by compiling BRouter's Java to WebAssembly (TeaVM → WasmGC), storing routing
data and basemap tiles in **OPFS**, and rendering with **MapLibre GL JS + PMTiles**.

There is **no backend**. No tile server, no routing server. Everything is static assets plus
client-side byte-range reads out of OPFS.

**Picking this up fresh? Read `HANDOFF.md` first** — current status, environment setup, and the
one open question.

Full design rationale, spikes, and phasing live in
`~/.claude/plans/i-want-to-build-purring-dream.md`. Read it before making architectural calls —
it records *why* each choice was made and which alternatives were disqualified. Where reality
has since contradicted it, `docs/phase-*-progress.md` records the correction.

## ⚠️ `brouter-link/` is read-only

`brouter-link/` is a **symlink** to a separate checkout of upstream BRouter at
`/Users/jwig/Dev/Personal/brouter` (currently `v1.7.10`).

**Never modify anything under `brouter-link/`.** Do not edit files, do not run `git` write
commands there, do not add/commit/stage inside it, do not run Gradle tasks that write into its
tree. It is a reference checkout and its own git repository.

The whole point of the architecture is that BRouter compiles **unmodified**: the only disk I/O in
the routing path is five `seek()`/`readFully()` calls, and TeaVM's
`VirtualFileSystemProvider.setInstance(VirtualFileSystem)` SPI lets us satisfy them with an
OPFS-backed shim instead of forking. Not forking is what keeps upstream 1.7.10+ mergeable.

If a change to BRouter genuinely seems necessary, **stop and raise it** — it invalidates a core
assumption of the plan and is a decision for the user, not a workaround to apply.

Read from it freely: source, `misc/profiles2/*.brf`, `docs/`, and the existing JVM tests are all
useful reference material.

## Layout and commands

```
engine/          Gradle + TeaVM. Compiles BRouter's Java to WasmGC and JS.
web/             Vite + React + TS PWA. Artifacts land in web/public/engine/ (generated).
  src/ride/      The ride screen: map, waypoints, routing, follow, navigation. This is the app.
                 The navigation kernel — progress, climbs, power, recording, library — is pure
                 and tested; `useRideTelemetry` is the only place it meets React.
  src/setup/     Overlay: importing data, and the diagnostics/parity harness.
  src/engine/    Worker, Comlink client, OPFS VFS and tile store.
  src/map/       PMTiles-over-OPFS source, basemap style, the MapLibre worker fix.
brouter-link/    Read-only symlink to upstream BRouter. See above.
docs/            Spike results and findings, one file per phase.
vercel.json      Static deploy: builds web/, serves web/dist. No backend, no env vars.
```

The JDK is Homebrew's `openjdk@21`. `~/.zshenv` exports `JAVA_HOME`, so Gradle just works:

```bash
cd engine
./gradlew syncProfiles                           # cycling profiles -> web/public/profiles2
./gradlew jvmParity                              # Spike 1 kernel reference corpus
./gradlew jvmRoutes                              # Phase 1 route reference (needs data/segments4)
./gradlew buildWasmGC generateJavaScript         # WasmGC + JS backends
```

```bash
cd web
npm run build-catalogue                      # refresh the tile catalogue from brouter.de
npm run fetch-map-assets                     # refresh glyphs + sprites into public/
npx vitest run                               # unit tests (currently just gpx.ts)
```

Basemap extracts come from Protomaps' **dated daily builds**, not the demo bucket the plan
named — `https://demo-bucket.protomaps.com/v4.pmtiles` is dead:

```bash
~/bin/pmtiles extract https://build.protomaps.com/20260906.pmtiles data/basemap/edinburgh.pmtiles \
  --bbox=-3.85,55.65,-2.55,56.20 --maxzoom=14
```

The dated builds expire — `20260801` already 404s — so pick a recent date.

If a JDK ever goes missing, it is almost always the environment rather than the build. `openjdk@21`
is keg-only, so `/opt/homebrew/opt/openjdk@21/bin` is not symlinked into `/opt/homebrew/bin` and is
not actually on PATH here — `java` resolves to `/usr/bin/java`, the macOS stub, which works *only*
because it forwards to `JAVA_HOME`. So `JAVA_HOME` is load-bearing. Recover with:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

Two traps, both hit during Spike 1: zsh reads `~/.zshenv` (not `~/.zshrc`) for non-interactive
shells, and Homebrew here is owned by `joeadmin` while builds run as `jwig` — a profile written to
the admin account has no effect.
`engine/gradle.properties` also registers the keg path for Gradle's toolchain detection, so the
toolchain resolves even when Gradle is launched from a different JVM.

```bash
cd web
npm run dev                                  # or: npm run build && npm run preview
npm run build && npm run spike-server        # LAN-serve + accept POSTed on-device reports
```

`spike-server` is `web/tools/report-server.mjs`: `vite preview` plus a `POST /spike-report` route
that writes to `docs/spike-runs/` (gitignored). It exists so results measured on a phone come back
exactly rather than retyped. LAN-only by design — it takes unauthenticated writes.

`web/public/engine/` and `web/public/profiles2/` are generated by Gradle but **committed**,
because a static host cannot build them: that needs JDK 21, Gradle, and the `brouter-link`
symlink to a separate local checkout. Regenerate with the commands above and commit the
result; never hand-edit. Only the `-PwasmDebug` sidecars (`.wasm.map`, `.teadbg`, the
deobfuscator, `wasm-gc/src/`) stay gitignored — delete them before shipping, or the service
worker precaches 800 KB of debug data.

### How BRouter gets compiled — and the substitutions

`prepareBrouterSources` **copies** the five BRouter modules into `engine/build/brouter-src` and
compiles from there. Never a Gradle composite build (`includeBuild '../brouter-link'`), which
would create `.gradle/` and `build/` inside the linked checkout. Add modules to
`brouterModules` in `engine/build.gradle`.

Some upstream code cannot be translated as-is, so `engine/build.gradle` declares:

- **`sourceSubstitutions`** — excluded from the copy, replaced from `engine/src/main/java`.
  Currently `btools/util/StackSampler.java` (needs `Thread.getAllStackTraces()`,
  `Thread.getState()`, `Locale$Builder`; statically reachable from `RoutingEngine` so DCE can't
  drop it).
- **`sourcePatches`** — expression rewrites. Currently two: `OsmTrack`'s
  `getPackage().getImplementationVersion()` (absent from TeaVM's `java.lang.Package`, and it
  lands in the GPX header, so it must be stable), and a depth bound on
  `OsmNodesMap.minVisitIdInSubtree` (see the stack-overflow note below).

**Every patch asserts it applied** — an upstream change fails the build rather than silently
reverting to untranslatable code. If you need another substitution, add it there with a `reason`;
do not edit `brouter-link/`, and do not fork a core class wholesale. Details in
`docs/phase-1-progress.md`.

Both the WasmGC build and the JVM reference build compile these same outputs, which is what keeps
GPX parity true by construction rather than by coincidence.

## Stack

| Layer | Choice |
|---|---|
| UI | React + TypeScript, Vite, `vite-plugin-pwa` |
| Map | MapLibre GL JS, via [mapcn](https://www.mapcn.dev/) copy-paste components |
| Basemap data | PMTiles archives in OPFS, read via our own `pmtiles` `Source` (see below) |
| Routing engine | BRouter Java → TeaVM → WasmGC, with the TeaVM **JS backend as a feature-detected fallback** |
| Engine host | Web Worker, Comlink RPC to the main thread |
| Storage | OPFS; `FileSystemSyncAccessHandle` (Worker-only on iOS) |
| Build (Java side) | Gradle; new `brouter-wasm` module; TeaVM Gradle plugin 0.15.0 (needs JDK 17+ to *run*; bytecode target stays `release = 11`) |
| Target | iOS 18.4+ baseline (Screen Wake Lock in home-screen PWAs); current iOS is 26.x |

Keep a **Capacitor escape hatch**: the `VirtualFileSystem` implementation stays behind an
interface so the UI and Wasm engine port to a WKWebView unchanged if OPFS durability forces it.

## Conventions and gotchas

- **Bit-identical parity is the regression net.** The Wasm build must produce byte-identical GPX
  to the JVM build for a fixed route corpus. Prefer adding to that corpus over writing new
  bespoke assertions.
- **Register `maplibregl.addProtocol()` before any `Map` is created** — it is global to the
  module, not per-instance. `setWorkerUrl()` has the same constraint; both are called at module
  scope in `MapPanel.tsx`.
- **MapLibre 6's worker must be pointed at explicitly.** It locates
  `maplibre-gl-worker.mjs` from `import.meta.url` at runtime, which no bundler can follow, so
  bundled it asks for `/assets/maplibre-gl-worker.mjs` and gets nothing. `maplibreWorkerEntry.ts`
  makes Vite emit the chunk and `maplibreWorker.ts` feeds the URL to `setWorkerUrl()`. **This
  cost the whole of Phase 3.** It hides well: a dev server's SPA fallback answers the missing
  path with `index.html` and a `200`, and MapLibre's try/catch around `new Worker` cannot catch
  an async parse failure — so the map just sits there with no error. A dead worker looks exactly
  like a broken tile source, because *every* source type is parsed in the worker pool.
- **The maplibre worker import must use its default export, not be a bare import.** maplibre's
  `sideEffects` field excludes `dist/*`, so a side-effect-only import is tree-shaken and the
  build silently emits a 0-byte worker chunk.
- **Precache glyphs and sprites in the service worker.** PMTiles archives do not contain them
  and MapLibre fetches them separately; skipping this yields an offline map with no labels,
  which looks like a styling bug. They live in `web/public/{fonts,sprites}`, are **committed**
  rather than generated, and are refreshed with `npm run fetch-map-assets`. `globPatterns`
  must keep `pbf` and `png`. Glyph URLs must be **absolute** — they are fetched from
  MapLibre's worker, where a relative URL resolves against `/assets/`.
- **`zoom` must be the input to a top-level `interpolate` or `step`.** Nesting it inside a
  `match` is a style validation error, and MapLibre reports that as an `error` *event* rather
  than throwing — so the map silently never loads.
- **Land cover is five opaque tiers, never one data-driven layer.** Protomaps stamps
  `sort_rank: 189` on *every* `landuse` feature, so a tile carries no draw order at all — and
  landuse polygons overlap constantly (a pitch inside a park inside a residential block). One
  layer with a `match` on `kind` would paint a park *under* the block containing it at random.
  `fill-opacity: 0.5` used to hide this by making order stop mattering, which is most of why
  the map read as washed out. Draw order lives in the layer list; see `src/map/landcover.ts`.
- **`landcover` is live at z3–z7 only, and `landuse` from z7 up.** `landcover` has zero
  features at z8+, so styling it for street zoom does nothing. It is worth drawing anyway:
  `urban_area` is the only built-up signal at continent zoom. Both share the class taxonomy.
- **`garden` is the most common land kind, and it is not a park.** 1,914 polygons in one 2×2
  block at z13 against 64 real parks, median area 17px². These are back gardens; painting them
  as parkland makes tenement streets read as green space. Its own tone, in a tier below the
  real greenery.
- **A `match` label may be an array, so never `.flat()` the expression.** Flattening splices
  the label arrays open and MapLibre then reads a kind name where a colour belongs — "Could not
  parse color from value 'farmland'". `style.test.ts` catches it.
- **Buildings barely exist in the archive**: 22–35 per z14 tile in central Edinburgh, because
  Protomaps only ships footprints at z15 (1,568 in the equivalent z15 tile). The `buildings`
  layer is therefore near-empty at our `--maxzoom=14`. Going deeper costs 2.6× (34 MB → ~88 MB
  for Edinburgh) and was declined. **`--maxzoom=16` returns a byte-identical archive to 15** —
  z15 is the upstream ceiling.
- **NCN route numbers are not in this data.** `roads.network` only ever holds road shields
  (`UK A Road Network`, `GB:trunk`) — no `ncn`/`rcn`/`lcn` in a 137-tile scan; Protomaps carries
  no `route=bicycle` relations. Cycleways also carry `min_zoom: 14`, so they are absent from
  z12–z13 entirely. An OpenCycleMap-style view needs a separate planetiler pipeline, not a
  style change. Do not go looking for it in the archive again.
- **Railways are not roads.** `roads` carries `kind: 'rail'`, and a filter that excludes only
  `path` gives a main line the road colour and the full 8px casing — it looks like a street you
  could ride down. `NOT_PATHS_OR_RAIL` excludes both.
- **Paths are their own layer, and `roads-casing` must exclude them.** Protomaps files
  footways, steps, sidewalks, crossings and indoor corridors under `kind: 'path'` alongside
  cycleways and tracks — 115 unrideable ways against 6 cycleways in one central Edinburgh
  tile. The `paths` layer allowlists `kind_detail`, so a kind added by a future schema
  version cannot quietly appear. Most of the old visual weight was the **casing**, not the
  line: an unfiltered `roads-casing` gave a footway the same 8px dark casing as a dual
  carriageway.
- **The chroma ceiling applies to strokes, not fills.** `pathTrack` measures CIELCh C 15.13
  on dark and C 15.30 on light, and *is* the "C ≤ 15.1" figure in
  `docs/phase-4-progress.md` — which quotes the dark value only. The rule it enforces is that
  a route *line* must not be confused with a line belonging to the map, so it binds on
  strokes: the three path tones separate on lightness at held chroma, and path *kinds*
  separate by dash pattern. **Land fills are deliberately above it** (`park` is C 23.6),
  because a 5px stroke cannot be confused with a park-sized area. `style.test.ts` asserts
  both halves, including a test that fails if the fills are pulled back under the line
  ceiling. On the light theme the path order inverts: darkest is most prominent.
- **`line-dasharray` is data-driven but not interpolatable.** MapLibre 6 types it
  `cross-faded-data-driven`, so one layer with a `match` on `kind_detail` covers every dash
  pattern — but `interpolate` is rejected, and dash units are multiples of line width rather
  than pixels. `[1, 0]` renders solid: `LineAtlas.addRegularDash` splices zero-length ranges
  out and wraps the remainder.
- **`validateStyleMin` does not check expressions.** It returns zero errors for a style with a
  zoom curve nested inside a `match` — exactly the bug that "cost the whole of Phase 3" class
  of silent failure. `style.test.ts` also compiles every paint and layout expression with
  `createPropertyExpression`, whose argument order is `(expression, rootKey, spec)`; passing
  the spec second makes every data-driven property report "data expressions not supported".
- **Toggle map layers with `setFilter`, not `setStyle`.** `setStyle` replaces every layer and
  takes the route line and position dot with it, so they have to be rebuilt — acceptable for
  the theme swap, wasteful for a button tapped three times to cycle modes.
- **Don't cap the map at the archive's max zoom.** MapLibre overzooms vector tiles by scaling
  the deepest tile it has; `maxZoom: header.maxZoom` throws away usable detail and puts
  street-level layers permanently out of reach.
- **Don't vendor `@makina-corpus/maplibre-offline-pmtiles`** as the plan suggested — it opens
  its own OPFS handles and collides with the engine's registry. `src/map/opfsPmtiles.ts`
  implements the `pmtiles` `Source` interface against the shared registry instead.
- **Do not ship mapcn's default CARTO basemap** — online-only, and commercial use needs a CARTO
  Enterprise licence. Replacing it is the first mapcn change.
- **Do not route against `brouter.de`.** Download-only usage of `segments4/` is the respectful
  pattern; the API has no published rate limits or ToS.
- **Tiles are import-only. The app never downloads routing data** — the user fetches `.rd5`
  files from brouter.de and imports them. Do not add a downloader: it is a deliberate
  simplification, and `brouter.de` sends no CORS header so a browser could not fetch from it
  anyway. The app's job is to say *which* tiles are needed and link to them.
- **Imported tiles go stale.** brouter.de rebuilds weekly; imports are snapshots that never
  update. Surface the age rather than hiding it.
- **Only one open OPFS sync access handle per file.** The engine's VFS and the tile downloader
  therefore share one registry in `opfsVfs.ts` — never open handles elsewhere. The registry
  also de-duplicates *in-flight* opens: two concurrent `openHandle` calls for one path would
  otherwise both reach `createSyncAccessHandle()` and the second throws `InvalidStateError`,
  because neither has populated the cache yet. Two Safari tabs collide the same way, and
  there is nothing the app can do about that one.
- **`zoom` must be the input to a top-level `interpolate` or `step`**, and **every `fill`
  layer must filter to `['==', ['geometry-type'], 'Polygon']`.** Protomaps ships canals,
  streams and rivers as LineStrings in the same `water` source-layer as lakes, and MapLibre's
  fill bucket closes a LineString into a ring and fills it — an unfiltered fill paints a canal
  as a lake-sized slab across the tile. `src/map/style.test.ts` asserts the guard on every
  fill layer.
- **`RoutingEngine.terminate()` can't cancel from a Worker.** It is cooperative and needs a
  second thread; during `doRun` the Worker is blocked in Wasm and processes no messages.
  `EngineClient.cancel()` terminates the Worker instead.
- **OPFS needs a secure context.** `navigator.storage` is `[SecureContext]`, so on a plain-HTTP
  LAN origin it is `undefined`, not merely restricted — device testing of anything touching
  storage requires HTTPS (`tools/make-certs.sh` + `npm run spike-server-https`).
  `http://localhost` is a secure context, which is why desktop testing never hits this.
- **Never size anything off `navigator.storage.estimate()`** — the value is deliberately fuzzed.
  Quota is ~60% of disk per origin (WebKit's figures, not MDN's).
- **Waypoints are fixed-point micro-degrees:** `ilon = 180000000 + lon*1e6`,
  `ilat = 90000000 + lat*1e6`.
- **Excluded from the Wasm build:** `:brouter-server`, `:brouter-map-creator`,
  `btools.util.StackSampler`, and the `Rd5Diff*` tools. Also avoid `car-vario*.brf`, the only
  profiles that reach `Class.forName` in `RoutingContext`.
- **`ProfileCache` invalidates on `File.lastModified()`** — the VFS must return a stable mtime or
  cache invalidation thrashes. `OpfsBridge.lastModified` returns a constant for this reason.
- **Stack-depth probes overestimate.** A trivial recursive probe reached 25,179 frames on
  device, but the real `minVisitIdInSubtree` overflowed at 2,000 — capacity is bytes, not
  frames, so frame size dominates. Measure with a representative frame, or treat probe numbers
  as an upper bound only.
- **WasmGC can't represent stack exhaustion as `StackOverflowError`.** It arrives as a JS
  `RangeError` that unwinds past even `catch (Throwable)`. BRouter *relies* on catching it in
  `OsmNodesMap.cleanupPeninsulas`, so the recursion is bounded by a `sourcePatch`. If you hit
  another unbounded recursion, bound it the same way — don't try to catch it in Java.
- **OPFS handles are opened async up front and stay open.** A sync `read()` can never reopen
  one, so `VirtualFileAccessor.close()` is deliberately a no-op.
- **`engineApi.init()` must open the imported tiles itself.** `installedTiles()` is what opens
  the `.rd5` handles *and* registers `/segments4` in the VFS's in-memory directory registry;
  without it BRouter reports `segment directory /segments4 does not exist` while the file sits
  in OPFS. This used to happen by accident because `TilesPanel` mounted on every page load —
  it broke the moment that panel moved behind Setup. Never let engine setup depend on a
  component having mounted, and note the failure only appears on a **cold start**, never on a
  reload with warm state.
- **Build with `-PwasmDebug`** to get Java names in browser stack traces; otherwise a fault
  reports only `wasm-function[NNN]`.
- **The service worker serves stale bundles after a rebuild.** Unregister it and clear caches
  before any verification run, or you will debug the previous build.
- **Never call `WebAssembly.Module.imports()`** — live JSC bug on iOS. TeaVM routes around it.
- Treat **~150 km air-distance** as the working routing ceiling (processing scales quadratically).
- **`options.release = 11` makes Gradle refuse TeaVM's 17+ artifacts.** `engine/build.gradle`
  overrides the `TargetJvmVersion` attribute to 21 on the resolvable configurations. Don't
  "simplify" that away — see `docs/spike-1-results.md`.
- **A Worker can't derive the app's base URL** once bundled (`self.location` is
  `/assets/<worker>-<hash>.js`). Pass `document.baseURI` in from the main thread.
- **Parse BRouter's GPX; don't add a second output format.** `FormatJson` would hand back
  GeoJSON directly, but the GPX corpus is the regression net — routing the map through the
  same `FormatGpx` output that parity checks makes what the rider sees provably covered.
  `src/ride/gpx.ts` does it, against fixtures that are verbatim `jvmRoutes` output.
- **`time=` is absent from the GPX summary for profiles with no energy model** (`shortest`).
  `timeS` is `null` there, not `0` — rendering "0 min" would be a lie.
- **Use `100dvh`, not `inset: 0`, for full-screen chrome.** In Safari proper the bottom
  toolbar overlaps a viewport-height fixed element and buries the action bar.
- **In a home-screen app the document must be screen-high, not just the fixed layers.** iOS 26
  standalone gives a viewport 62px (the status bar) shorter than the screen, anchored at the
  top, and WebKit rasterises only the document's own box — so a page made of nothing but
  `position: fixed` children is laid out to the full `100lvh` and then never painted below
  the viewport line. `ride.css` sets `html, body { min-height: 100lvh }` under
  `(display-mode: standalone)` for this reason; once it does, `innerHeight` and `dvh` grow to
  the full height too and fixed elements need no bottom offset. Measure with pixels, not
  `getBoundingClientRect()`: the rects were right the whole time.
- **`plan.chosen` is nullable, and that is the point.** After comparing profiles it is `null`
  until the rider picks one — on a route line on the map, or on a row in the sheet. A run that
  returns a single route commits to it automatically, because there is nothing to weigh it
  against. Before this, `focused` was seeded with `'trekking'` and could never be empty, so the
  elevation profile silently described one of six routes. Anything that reads "the route"
  (`plan.route`, the stats rail, Start) must handle `null` rather than fall back to a default —
  the fallback *was* the bug.
- **A tap on a route line beats a tap on the map**, and does nothing while riding. Choosing is
  the more specific intent, and dropping a waypoint on the line you were pointing at would
  reroute the thing you were trying to select. Mid-ride the decision is already made, so
  `routeAt` is skipped entirely — a bump in the road must not throw the drawer over the map.
- **The `--panel*` translucency tokens live on `:root`, not `.ride`.** vaul portals the drawer
  to `<body>`, so anything scoped to the ride screen is invisible to it.
- **Route colours are chosen on chroma, not hue.** Every *stroke* in both basemap palettes is
  C ≤ 15.4, so a route line at C ≥ 45 cannot read as map furniture whatever its hue — that one
  constraint is what separates a line from the map. The old muted palette failed it: `shortest`
  was ΔE 7.5 from the light theme's boundary colour, and a lone route's near-white was ΔE 4.4
  from its buildings. **Blue is the binding case**: the basemap spends blue-grey on water,
  roads and boundaries, so `fastbike` is the worst approach in both themes at ΔE 17.15 — and
  the ΔE 18.0 once quoted in `profiles.ts` was wrong, measured without the label colours while
  `fastbike` sat 15.5 from the dark water label. `style.test.ts` now asserts a floor of 16 over
  **every** palette colour, labels included. Six categorical colours cannot all separate under
  dichromacy — survivable only because identity is never colour alone. Figures and method in
  `docs/phase-4-progress.md` and `docs/phase-5-progress.md`.
- **Every route is drawn in its profile's colour, including a lone one.** The near-white
  single-route colour was invisible on the daylight map, and keeping the rule uniform means the
  map does not repaint when a second profile is ticked.
- **Setup is an overlay over the ride screen, never a replacement.** Unmounting the map drops
  its OPFS handles and its whole tile cache; the map controller therefore lives in `App.tsx`.
- **A fix is snapped to the route with a *hint*, and the hint is load-bearing.** Nearest-point
  over the whole polyline is O(route) per fix and wrong on any route that crosses itself — an
  out-and-back is two coincident lines and the search picks between them by floating-point
  luck, so a rider on the way home sees the distance remaining jump back to the full route
  length. `snapToRoute` searches −120 m to +600 m around the previous answer first and only
  falls back to a global scan when that match is worse than 45 m. A tie goes to the window:
  a progress bar that lags beats one that jumps.
- **A climb is the best-scoring stretch of a run, not the run.** `gradients()` resamples,
  smooths and prunes by persistence — then extracts the sub-stretch maximising `gain²/length`
  and recurses either side. That score is chosen because at constant gradient it prefers the
  *whole* climb (it reduces to `grade² × length`), so a steady 4% is reported once. Without the
  extraction, London → Brighton reported **nothing** across 17 km because a 62 m ramp at 6% was
  buried inside a 9.8 km run averaging 1.2%. Smoothing costs accuracy in one direction: a true
  6% reads as 5.3%. `docs/phase-6-progress.md` has the numbers.
- **Gradient comes from the route, never from the fix.** GPS altitude is tens of metres out and
  drifts standing still; differentiated, it swings ±20% and that is ±600 W of invented power.
  `gradeAt` reads BRouter's own SRTM elevations over a ±60 m window. The corollary is that
  power and recorded ascent are only meaningful on the route, and both are cleared the moment a
  reroute replaces the geometry.
- **The two ride overlays are achromatic, and that is a rule not a preference.** Six route hues
  at C ≥ 45 already fill the usable circle under the ΔE ≥ 16 clearance floor. "Already ridden"
  is neutral grey — it has stopped being a route — and "climb ahead" is a blurred halo in black
  or white by theme, which is a *lightness* effect and so needs no clearance rule and works
  over a line of any colour. Do not give either one a hue.
- **The route library is IndexedDB, and neither of the other two stores would do.**
  `localStorage` is ~5 MB per origin *shared with the plan, the theme and the basemap choice*,
  so twenty 240 kB GPX documents evict all of them with a silent `QuotaExceededError`. OPFS is
  the wrong shape — it exists to serve sync access handles to the engine Worker under a
  one-handle-per-file registry, and routes want keyed records.
- **Reversing a route must re-route it.** One-way streets and turn restrictions are not
  symmetric: the test route measures 9.2 km / 140 m out and 10.1 km / 103 m back. Reversing the
  drawn geometry would put a line on the map the rider cannot legally follow and quote the
  wrong figures for it.
- **`easeTo` already turns the short way round**, so do not write the arithmetic yourself:
  MapLibre 6's `_normalizeBearing` picks the nearest equivalent of the target to the current
  bearing. A `shortestTurn` helper was written here on the assumption that it interpolated
  numerically, and it was simply wrong. What *is* still needed is `angleGap` — no two headings
  may be compared with `Math.abs(a - b)`, which says 350° and 10° are 340° apart.
- **Recentring and rotating must be one `easeTo`, not two effects.** `easeTo` stops whatever is
  in flight and defaults its target centre to the *current* centre, so a rotation issued in the
  same commit as a recentre cancels it before its first frame — the map turns to face the right
  way and then never follows the rider. Both effects had `heading` in their dependencies, which
  is what put them in the same commit.
- **`DeviceOrientationEvent.requestPermission()` only resolves from a user gesture on iOS**, so
  the compass cannot be asked for on mount. `useHeading.request()` is called from the course-up
  button and from Start, both of which are taps. The GPS course is the fallback and is `null`
  below a few km/h — which is every junction and every set of lights, hence wanting the compass
  at all.
- **Speech is sparse on purpose, and `speechSynthesis` fails silently in three ways.** The
  first utterance needs a user gesture on iOS (hence `prime()` from Start), utterances queue
  rather than replace (hence `cancel()` before each), and the voice list loads async (hence
  never picking a voice). A fourth, caught in the browser: `prime()` must **not** check
  `enabled`, because `riding` is still false in the render its closure came from — gating there
  swallowed the one utterance that unlocks the rest of the session. The cue rules live in
  `cues.ts`, are pure, and are tested by walking a real route: fourteen cues over 95 km. If you
  add a cue, it has to change what the rider does in the next minute — an app that talks
  constantly gets muted, and a muted app says nothing at all.
- **A hidden browser tab never fires `requestAnimationFrame`, and MapLibre's style loader
  awaits one.** The map then silently never loads: no `load` event, no `error`,
  `isStyleLoaded()` false, `getStyle()` undefined, and **zero** sprite or glyph requests in
  `performance.getEntriesByType('resource')`. `styleReady` never flips, so route layers are
  never added and waypoint markers are never created — which looks exactly like a marker bug
  and is not. Shim `requestAnimationFrame` to a `setTimeout` before the map is built when
  driving the app from headless automation. Close cousin of the dead-worker trap above.
- **The iOS Simulator reaches the Mac's `localhost`, which is a secure context** — so it needs
  no HTTPS and no trusted CA, unlike a physical device. `simctl` is not on PATH here:
  `xcode-select` points at CommandLineTools, so use
  `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl`. `simctl location <udid> set`
  drives follow mode.

## Verification

Desktop Safari and the Simulator both diverge from real devices on storage and Wake Lock
behaviour. **On-device testing on a real iPhone, added to Home Screen, is non-negotiable** before
calling anything done. The acceptance test is: airplane mode, cold launch, plan a route, follow
it.
