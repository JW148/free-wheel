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
                 The navigation kernel — progress, climbs, power, ascent, recording, library,
                 hud, ways, turns — is pure and tested; `useRideTelemetry` is the only place it
                 meets React. `ways.ts` and `turns.ts` read what BRouter wrote into the GPX:
                 what the road is made of, and where to turn.
                 Stops along the way are `insertionIndex` and `plan.shaping`, both in the same
                 kernel. There is no via mode: a tap already knows where in the order it goes.
  src/onboarding/ The six-card first run. Each card shows the screen it is about, clipped out
                 of the running app by `tools/onboarding-shots.mjs`. Its bike question writes
                 to the rider, not to the plan. It swipes as well as pressing Next; `swipe.ts`
                 holds the decisions.
  src/search/    The offline place search. `buildIndex.ts` runs in the engine Worker and reads
                 every name out of a basemap archive; `placeIndex.ts` packs, folds and ranks;
                 `searchStore.ts` owns it as a module singleton like `downloadStore`.
                 Saved places and recents are `places.ts`, and `gazetteer.ts` is the 48 kB of
                 British towns that lets the app name the region a place you typed is in.
  src/library/   The Saved screen. An overlay over the map like Setup, never a replacement.
  src/setup/     Overlay, and the settings list that pushes to Maps and Rider: the maps
                 library, the region browser,
                 the download queue, rider settings and the diagnostics/parity harness.
                 `regionShapes.ts` turns the published bboxes into areas painted onto the map.
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
node tools/build-gazetteer.mjs <gb.pmtiles>  # refresh public/gazetteer.json (committed)
npm run build && npm run shots               # refresh public/onboarding/*.webp (committed)
npx vitest run                               # unit tests
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
node tools/drive.mjs <url> <out>             # look at the app at 390px, no engine needed
node tools/drive-stops.mjs <url> <out>       # …and with a real engine, for stops and shaping
node tools/drive-surface.mjs <url> <out>     # …and for the surface strip, the breakdown, the turns
```

`drive-stops.mjs` and `drive-surface.mjs` are separate because neither flow can be driven from a
seeded plan. For stops the whole question is what happens between a tap and the line moving; for
the surfaces and the turns the data is what BRouter *writes into the GPX*, so a seeded fixture
would show the strip drawn from whatever was seeded rather than from what the engine said. Both
import a real basemap and a real `.rd5` and every route in them is an actual BRouter run, and
both take `--keep` to reuse the browser profile so the 86 MB import happens once. All three
scripts hardcode a preview port — check nothing else is on it first, because a stale
`vite preview` from a finished worktree will serve you the *previous* build with no warning.

**Driving the app in both themes is not optional for anything drawn on the map.** The main-road
mark passed every unit test, looked right on the light theme, and was invisible on the dark one,
because its colour and most of the dark basemap are both `#06141b`.

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
| UI | React + TypeScript, Vite, `vite-plugin-pwa`. Light chrome; tokens in `src/tokens.css` |
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

- **Every colour, shadow and radius is a role token in `src/tokens.css`, with a value per
  theme.** `<html data-chrome>` selects between them, from the same state that picks the basemap
  palette — so the map and the chrome are never one theme apart. The dark theme is not a second
  design; it is the same names re-mapped onto the slate ramp, which is the only arrangement in
  which the two cannot drift. Never name a colour directly in a rule. The old names (`--bg`,
  `--surface`, `--raised`, `--text`, `--rule`) survive as aliases and should not be used in new
  code. `ride.css` used to redefine four of these in a `:root` block of its own and won a
  cascade nobody knew was happening; do not reintroduce that.
- **`chrome.test.ts` is the light theme's net, and it is not `style.test.ts`.** They answer
  different questions: ΔE-against-the-basemap is "can this be mistaken for a road", contrast
  ratio is "can this be read". A route line is deliberately far more saturated than anything
  WCAG has an opinion about, and chrome colours are never added to the ΔE floor. Going light
  made four slate-era colours fail outright — figures in `docs/phase-11-progress.md`.
- **A gradient band has to clear 3:1 on white *and* on `#11212d`**, which confines every one to
  a relative luminance between about 0.14 and 0.30. That window is roughly 2:1, so a band cannot
  be darkened freely: scaling two of them to the same contrast target lands them on the same
  luminance and destroys the severity ramp. The scale is read by **hue** at roughly held
  lightness — the standard cycling convention — so `flat` sitting between `rising` and `steep`
  by luminance is correct, and a monotonic lightness ramp across all six is an invention neither
  the design nor the original ever made.
- **The plan sheet reopens on the view it was put away on.** `openForPlan` used to re-derive it
  from the plan — a chosen route meant the detail — which overruled the rider: choosing does not
  leave the comparison, so minimising while weighing three cards and pulling back up landed on
  one route's climbs. `viewOnOpen` keeps the last view and has exactly one exception, the
  detail with no chosen route to describe.
- **Two taps produce three routes, and `plan.chosen` is still `null` until one is tapped.**
  Placing the second waypoint routes automatically; there is no Compare button and no tick-list.
  `profiles.ts` carries both a `label` (the engine's name) and a `plain` name (the rider's), and
  `DEFAULT_PROFILES` is the three that are offered. The engine name appears only in the detail
  view's pill, which is the one place it is the useful fact rather than noise.
- **`COMPARE_CEILING_M` is not `AIR_DISTANCE_CEILING_M`.** 50 km against 150 km, measuring
  different things: the larger is where *one* route gets uncomfortable, the smaller is where
  *three* do. Past the smaller, only the rider's own style runs and the other cards offer to
  compute themselves on a tap. `profilesToRun` is pure and tested at either side of it —
  including that a **lone profile is never deferred**, which would otherwise leave a rider past
  the ceiling with no route at all and no obvious way to ask for one.
- **A run commits each result as it lands, not all of them at the end.** The first card fills in
  while the second is still computing. Collecting them into one `setRoutes` at the end turns a
  list assembling itself into a spinner.
- **The rider's preferred style lives on `RiderSetup`, not on the plan.** A plan is a route and
  changes every tap; what you ride changes about once a year. It decides which card is suggested
  first and which single profile the distance guard runs.
- **A tap on the map always places a waypoint while planning.** The pin toggle is gone: the plan
  card names every point and gives each an explicit ×, so a stray tap is one tap to undo and
  visible the moment it happens — where the toggle was a mode you could be in without knowing,
  which is how a rider ends up tapping a map that has stopped responding. Riding still refuses
  taps entirely, and *that* guarantee is the one worth keeping.
- **A tapped point goes wherever it costs least, and that is the whole of stops.**
  `insertionIndex` scores each leg by the detour it would add — `d(a,p) + d(p,b) − d(a,b)` —
  against `d(finish,p)` for extending past the finish, and takes the cheapest. One formula gives
  both behaviours a rider expects: beside the line bends it, past the finish lengthens it. So
  there is no via mode to arm and no Add-a-stop button on the map. Measured over the
  **waypoints**, never the drawn route — nearest-point-on-the-line has no answer when the route
  is stale, failed or absent, and says nothing about how far out of the way a distant tap is.
  Prepending is deliberately not a candidate (the start is the one point a rider is sure about,
  and the search slot and the pin drag both move it properly), and ties go to the earlier leg,
  which only arises on a loop where the two legs are coincident and the intent is ambiguous
  anyway.
- **Every edit routes: a tap, a pin drag, a removal.** The one-to-two transition used to be the
  only trigger, which is what made extra pins decorative — the rider placed them and the line
  went on describing the two-point journey underneath. A drag fires on `dragend` only, so it is
  one search per drag and there is no debounce anywhere.
- **You cannot shape a comparison, and `plan.shaping` is that rule.** Three cards are three
  answers to "which way between these two ends"; a stop changes the question, so above two
  points exactly one profile runs and nothing is deferred — a deferred card offers to compute
  itself, and there is nothing left to compute it *against*. The profile is
  `isRoutableProfile(chosen) ? chosen : preferred`, the same fallback `rerouteProfile` uses and
  for the same reason. **`plan.selection` is left alone**: it is what the rider is offered, not
  what is on the map, so removing the stops restores the comparison.
- **A shaping run keeps the old line and dims it; every other run blanks the source.** The
  `stale` `RouteState` exists for the second or two the Worker blocks inside Wasm — a blank map
  reads as the app having dropped the tap. It beats every other state, including an open
  comparison, because the run is about to replace all three lines with one. Never dimmed while
  riding: that line is still the road being followed. A shaping run also **replaces** the route
  set rather than merging, and commits nothing when it fails.
- **Don't frame the camera on the waypoint count.** It used to, and under shaping that is a
  re-fit per tap — the rider zooms in, taps, is pulled back to the overview, zooms in again. The
  fit signature is the profile ids plus `plan.framing`, bumped only when the line becomes a
  different journey *without being cleared first*. Everything else (a new run, Reverse, a new
  end from the search, Make a loop) blanks the route and frames itself on arrival; loading out
  of Saved does not, which is what the counter is for.
- **`waypointRows` names and numbers every point, and three surfaces read it.** The map pins,
  the plan card and the sheet's list all used to derive `S` / `1` / `F` / `Rejoined` for
  themselves. A rejoin is named rather than counted so it cannot renumber the pins the rider
  placed. `PointList` is the row markup, used by the card and the open sheet — the sheet's own
  `Start | coordinates | Remove` table is gone and should not come back.
- **Make a loop is a button because a tap cannot be one.** Nobody taps exactly on their own front
  door, so closing a plan onto its start is the only part of stops that needs a control. It
  lives in `.sheet-actions` beside Reverse and Clear — the things that act on the whole plan —
  and is disabled inside `isLoop`'s 50 m. What it appends is an out-and-back, which is honest:
  the circular ride comes from the stops placed after it. Those three labels may not wrap, or
  the sheet's two measured heights disagree mid-animation.
- **The map carries two buttons: Layers and Locate.** Anything you set once and never touch again
  belongs in the Layers sheet, not on the map. The collapse chevron went with the other five
  buttons — it was a control for a control.
- **Onboarding has its own storage key, and it is not the maps gate.** `free-wheel.onboarded.v1`
  answers "has this rider met the app"; the gate answers "does this phone have anything to ride
  on". A rider who deletes every region to free space must get the second and never the first.
  Skipping counts as having seen it.
- **The walkthrough is shown once by itself and reachable for ever from Setup**, as the third
  row — *How this app works*. It used to retire the moment it was finished, which is a strange
  fate for the only six screens that explain the app, and the premise a rider forgets between
  seasons (download the map before you leave) is on card two. Shown again it *reports* rather
  than *asks*, and all three differences guard the same thing: the bike chips start on
  `bikeFor(rider)` and on **nothing at all** when no chip describes the rider's setup;
  **finishing writes the rider only if a chip was tapped**, so reading the cards cannot reset
  someone's tyres; and the last card stops asking for location, because a browser that was
  refused once will not prompt again however the button is worded. `bikeFor` matches on all
  three fields — `style` alone would confuse gravel with mountain, which share a profile and
  differ on tyres by nearly 2× in rolling resistance. `App` owns which of the two lives it is
  in, because the first run covers the maps gate while a revisit is drawn *over* Setup, which
  has to still be there to come back to.
- **The onboarding pictures are clipped out of the running app, and are never drawn.**
  `web/tools/onboarding-shots.mjs` drives the built app in headless Chrome against a real
  basemap and a real BRouter segment, plans a real route, rides it, and clips six rectangles at
  roughly life size into `web/public/onboarding/*.webp` — committed, for the same reason
  `public/engine/` is. They replaced pixel glyphs on the icon's own 20x14 grid, which cost
  nothing and said nothing: twenty cells cannot draw "three routes you compare", and two bikes
  side by side read as a pair of spectacles. **A mock would be worse than the glyph it
  replaced**, because the whole point is that a rider meets the ride screen already knowing
  what they are looking at — so regenerate rather than retouch, and never hand-draw one.
  The script needs `FW_BASEMAP`, `FW_RD5` and `FW_PICKER` (all under `data/`, none committed),
  `--full` writes whole screens to `web/shots/` for choosing a crop, and `--keep` reuses the
  browser profile so the 86 MB import does not happen twice. The region shot stands the mirror
  in with a fixture manifest and is **clipped above the bar that states a size**: the bucket's
  first upload has never happened, so the only megabyte count available is invented, and a
  screenshot makes an invented figure permanent.
- **A clipped rectangle, not a shrunken screen.** A whole 390x844 screen scaled into the card's
  tile lands at about a third — a silhouette, legible nowhere. The pictures are clipped to the
  part that matters and drawn at around 86%, which is what makes a rider recognise the plan
  card, the route cards and the riding panel when they meet them a minute later. The tile takes
  a fraction of `--app-height` between two bounds rather than a fixed aspect ratio: a fixed one
  pushes the text off a short phone, and `flex: 1` would absorb the slack and float the text
  away from the top. `Slide.focus` says which part of a picture survives the crop.
- **Two of the six shots are framed by measuring, not by a constant.** The app fits a route to
  a 390x844 screen and the card is nowhere near that shape, so at the app's own zoom the two
  pins — the literal subject of "tap your start, tap your finish" — fall outside the crop. The
  script reads the markers' rects, pulls the map back until they fit the band the card will
  show, and centres the window on them. The region browser gets the same treatment for the same
  reason, or England falls off the card about picking an area of Britain.
- **Saved and the Setup screens are overlays over the ride screen, never replacements** — the
  rule Setup has always had, for the reason it has always had it: unmounting the map drops its
  OPFS handles and its whole tile cache, and loading a route from Saved puts one straight back
  onto that map.
- **Ending a ride is a hold, not a tap.** Same argument as the missing text field: the riding
  screen is used on rough ground in gloves, and a tap is a gesture a pothole can make on the
  rider's behalf. `HoldButton` must handle `pointercancel` as well as `pointerup`, or a scroll
  or a system edge gesture leaves the hold running with nothing pressing it.
- **The finish sheet must never grow a text field**, whatever a design shows. iOS shake-to-undo
  cannot be refused. The ride saves itself under a generated name; renaming is in Saved.
- **A stop is named only when it came off the search.** The search screen's one extra row —
  `+ Add a stop`, or `2 stops · add another` — is the only gesture that sets `PlanSlot`'s
  `'stop'`, which had been written and unreachable since the screen existed. It is quieter than
  the two fields because it is an action rather than a value; a third row in the same clothes
  claims a stop the plan has not got. `placeAt` keeps the drawn line for this slot **and only
  this slot**: a stop leaves both ends where they were, so the line is stale rather than wrong,
  where a replaced end makes it wrong — and a wrong line is worse than none.
- **There is no geocoder and there is not going to be one.** Turning a *position* into a name
  is a network service and the whole app is built on not needing one. A point the rider tapped
  on the map shows coordinates to four decimal places — about 11 m, enough to tell two taps
  apart. A point they chose **by name** off the search keeps that name in `Waypoint.label`,
  which is the other direction and costs nothing. The place index makes offline reverse
  geocoding genuinely possible now; doing it anyway is a decision for the user, not a thing to
  slip in — see §4 of `docs/phase-12-progress.md`.
- **The search reads the names already on the phone; nothing is fetched.** Each basemap archive
  carries them on its places, POIs, roads and water, and the index is built once per archive by
  scanning the archive's **deepest zoom only** — Protomaps repeats every feature upwards from
  its own `min_zoom`, so z14 carries everything and anything shallower silently loses the
  streets. It runs in the **engine Worker**, because that is where the OPFS handles are and
  because one handle per file is the rule; it blocks that Worker for seconds, so
  `searchStore.hold(true)` stops it for the length of a ride. Edinburgh: 2,760 tiles, 21.6 MB,
  285 ms, 34,927 entries, ~0.9 MB packed. Freshness is by archive **byte count**, never a hash.
- **A reroute adds to the ride; it does not replace it.** The engine is asked only about the road
  ahead, and `stitch.ts` joins the answer onto the part already ridden — so the trip length, the
  progress bar, the climbing done and the original start all survive a wrong turn. The plan keeps
  every via already passed and gains the rider's position as a `kind: 'reroute'` point, drawn as
  a quiet dot that does not renumber the pins they placed. **`stitchRoute` must set `resumeAtM`**
  and the telemetry must seed its snap hint with it: a stitched route's first half is road the
  rider has already been down, and a hintless global scan on an out-and-back puts them back
  where they were an hour ago. `splitWaypoints` returns both halves from one function so they
  cannot disagree.
- **`--mode` is the one role token that does not invert.** It fills the riding bar and the
  "tap the map" strip — the app's two statements that it is in a mode. `--ink` is right on light
  and is a torch in the face on a night road; `--slate-700`, the obvious dark answer, measured
  ΔE 6.9 from the card it has to be distinguishable from. It is a deep green in both themes and
  `chrome.test.ts` holds the contrast and the ΔE.
- **`overflow: hidden` on a grid item makes it squeezable.** It is what rounds a list's first and
  last rows against its card, and it also makes the list a scroll container — whose automatic
  minimum size is 0. The grid row then compresses it: 21 search results laid out 692 px tall over
  1,417 px of rows, clipped the rest, and told the scroller everything fitted. `.place-list`
  carries `min-height: min-content` and `.search-body` carries `grid-auto-rows: max-content`;
  without the second, the footer under the list gets no height and is drawn across it.
- **`column-reverse` over `<dd>` then `<dt>` puts the *label* on top, not the value.** That is
  the opposite of what the comment beside it claimed, and it was wrong from phase 4 until phase
  11. Every figure block is now `<dt>` then `<dd>`: the correct order for a description list,
  and the one that renders the value above its label under `column-reverse`.
- **`web/tools/drive.mjs` drives the built app in headless Chrome at a true 390 px.** Not a test
  — a way to *look* at the thing, in both themes, with a seeded plan and a faked fix. It found
  both of the two bugs above that no unit test could. It works around the four traps recorded
  elsewhere in this file: the stale service worker, the missing `requestAnimationFrame`, one app
  tab at a time, and `--disable-gpu` killing WebGL2.
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
  must keep `pbf` and `png` — and `webp`, which is the walkthrough's six pictures: it runs
  before anything is downloaded, so a second launch in a tunnel must not be six broken images.
  Glyph URLs must be **absolute** — they are fetched from
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
- **Every installed archive is drawn at once, and its layers interleave by role.** A phone
  holds one `.pmtiles` per downloaded region and the map carries a source — and a full layer
  set — for each, so there is no "current" archive and no border at which the map goes blank
  while routing carries on working. The published regions *overlap*, so stacking one archive's
  whole layer set after another's paints the second region's land fills over the first's roads:
  streets that stop along a line across the map. Order is role-major (`basemapRoles()`), layer
  ids are `role|archive`, and `composite.ts` splices a new archive in at each role's position.
  Never append.
- **A finished download joins the map with `addSource`, never `setStyle` or a new `Map`.** Both
  of those discard the route line, the position dot and every waypoint marker — and a region
  can land while the rider is following a route.
- **`useMapLibre.sync()` is the only way the map changes.** Startup, a finished download, a
  hand-imported archive and a removed region all go through it; it reads storage and reconciles.
  One entry point, because the previous arrangement had two pieces of code making the same
  decision from the same inputs and only one of them ever got fixed.
- **The browse screen is a map with one bar on it.** The bar is built from the ride screen's
  `.sheet-bar` vocabulary and holds three fixed slots — the way back, what is chosen, the one
  action — and the list is the ride screen's `vaul` drawer, starting closed. Both bar lines are
  clamped to one line: the height has to be constant, or a long region name moves the button out
  from under the rider's thumb. Picking from the list frames that region and closes the drawer;
  picking on the map moves nothing, and `BrowseMap` tells them apart by the *identity* of its
  `frame` prop, because both produce the same `selectedId`.
- **The region browser owns its own MapLibre instance and does not borrow the ride screen's.**
  The old picker streamed Britain over the shared map and handed it back, which was the most
  delicate thing in the app — an async teardown racing React's effect ordering, three rounds of
  fixes, and a failure where the rider was left on a streamed map of Britain wearing their own
  map's clothes. None of it was about picking a region. `BrowseMap` builds its own and
  `remove()`s it on unmount. Do not reintroduce a loan.
- **Downloads belong to `downloadStore`, not to a screen.** It is a module singleton like
  `sharedEngine`, so a rider can queue four regions and close Setup. `App` subscribes to
  `onInstalled` and syncs the map — the Maps screen is usually not mounted when one lands.
- **A cancel must not overtake the start it is cancelling.** `EngineClient.cancelRegionDownload`
  awaits `init()` for no other reason: `downloadRegion` posts its Comlink message only after
  that await, so a cancel that skipped it arrived first, found no controller registered, and did
  nothing — 166 MB downloaded for a region whose row had already gone from the screen. Awaits on
  one promise resume in the order they were made; that ordering is the fix.
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
- **Routing data comes from our mirror, never from brouter.de.** The app downloads regions
  from a bucket the mirror publishes to. The two scripts that fill it, their shared pure logic,
  the bucket layout, the CORS rule, the refresh commands and the five environment variables they
  need all live in `web/tools/mirror/` — start at its `README.md`. They are written and tested;
  what has never happened is the first upload, because that needs credentials (see
  `docs/phase-8-progress.md`). **Nothing is scheduled**: both scripts are run by hand from a
  laptop, and that run is the only thing that ever talks to brouter.de, at five conditional
  requests per refresh — the 14 regions share just five BRouter grid cells. Cadence is not load-bearing — staleness is decided by
  comparing hashes, never by a calendar, so the app cannot tell when the last run happened.
  Never fetch from brouter.de in the app: it sends no CORS header, so a browser could not
  anyway, and never route against its API.
  Manual `.rd5` and `.pmtiles` import stays as an escape hatch for a bucket outage and for
  testing custom extracts.
- **Imported data goes stale, and the mirror is what tells you.** Every object in the bucket is
  content-addressed, so an update is offered only when the bytes actually differ. A weekly
  upstream rebuild with identical bytes is not an update.
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
- **The app asks for `turnInstructionMode = 9`, and that is the only mode that carries the
  data.** It emits `<brouter:way>` at every change of road tags *and* `<brouter:voicehint>`
  with a `<sym>` at every junction, which is where the surface breakdown, the map's marks and
  turn-by-turn all come from. **Set it after the `RoutingEngine` constructor, never before**:
  the constructor calls `ProfileCache.parseProfile`, which calls `readGlobalConfig`, which
  assigns the field from the profile's own globals — zero for every profile shipped here — so
  setting it first is silently reverted and the GPX comes back with no extensions at all.
  The tags cost nothing: BRouter's second, guide-track pass already runs in detail mode and
  builds them. Measured on the JVM, mode 9 is **not slower**; the GPX roughly doubles.
- **The corpus runs every case at both modes — 20 entries, not 10.** Mode 0 stays because it is
  what any other BRouter client would produce. `ReferenceRoute.timode` is absent on a reference
  file older than this, where 0 is the only mode there ever was.
- **`edinburgh-short` exists so parity can actually be checked.** Every other case is in
  southern England, so replaying the corpus in a browser needed `W5_N50` and `E0_N50` in OPFS —
  215 MB through the file picker, half an hour, a check nobody runs. That case sits in
  `W5_N55`, the 26 MB tile the driver scripts already import, and `tools/drive-parity.mjs`
  compares the running app's GPX to the JVM's by length and SHA-256 in about a minute. It
  proves V8 against HotSpot; the **JSC** claim still needs the Diagnostics panel on a phone.
- **The `.rd5` tiles know about cycle networks; the basemap does not.** `lookups.dat` carries
  `route_bicycle_ncn`/`rcn`/`lcn`/`icn` as well as `surface`, `smoothness` and `tracktype`, so
  a *route* can be measured against the National Cycle Network. It is **membership, never a
  number** — the app can say "42 km on the National Cycle Network" and can never say "NCN 20",
  even when that is exactly what it is. This does not reopen the overlay question in
  `docs/phase-5-progress.md`: a road the rider is *not* on still cannot be drawn as part of it.
- **Ways and turns are indexed by track point, and `ways.ts`/`turns.ts` convert to metres.**
  Never measure them off BRouter's `track-length` — they have to agree with the elevation
  profile's x-axis and with `snapToRoute`, and `routeGeometry` already caches the cumulative
  array. `ParsedRoute.ways`/`.turns` are **`undefined` rather than `[]`** on a route with no
  extensions, because a recorded ride cannot describe its surfaces at all where a route down
  one road genuinely has no turns.
- **`stitch.ts` must shift the fresh half's indices by the prefix's length.** A prefix is a
  leading slice so its own indices are unchanged; get the suffix wrong and the road ahead is
  described with the tags of the road behind, which looks plausible all the way down. Cut on
  `kept`, not `coords.length` — the interpolated cut point is pushed on the end and is not an
  original index.
- **Never invent a warning out of a missing tag.** An untagged `surface` is `unknown`, not
  `paved`: the map dashes unpaved stretches, and a guess there is a claim about the world made
  out of a gap in OpenStreetMap. A `highway` value the table has not seen is `road`, never
  `main`. `Not recorded` earns a row in the table — it is a quarter of the London–Brighton
  route — and gets no mark on the line.
- **A slight turn is drawn and never spoken, and that one rule is what keeps the app quiet.**
  London to Brighton has 322 junctions over 95 km; slight turns are 125 of the 285 actionable
  ones and are mostly a road bending where another joins. With them the cue walk produced 267
  utterances, one every 54 seconds. Without: 165 over 3.8 hours. They still *chain* — "left,
  then bear right" costs no extra interruption — and `cues.test.ts` holds the budget, so a
  change that makes the app chatty fails a build rather than a ride.
- **Turn cues are timed, not spaced**: 15 seconds of warning, floored at 60 m. A fixed distance
  is two streets early in town and late at 50 km/h downhill. The 400 m cap only binds above
  96 km/h, so it is a backstop for a bad fix rather than a path any ride takes.
- **A cue that speaks two events must mark both said, and that is `Cue.covers`.** A chained
  pair — "left, then right" — is one utterance answering for two junctions. Keyed on the first
  only, the second was found again on the next fix and announced alone a few seconds later:
  the exact failure chaining exists to prevent, and worse than not chaining, because
  `useAnnouncer` cancels rather than queues so the repeat clips the sentence still speaking.
  It cost 36 utterances on the reference route. Neither test caught it — one asserted the
  `{ turn, then }` shape, the other that no *key* repeats, and the repeat had a different key.
- **There are no street names at a turn and there cannot be from this data.** `lookups.dat` has
  no `name` key, so the `.rd5` tiles do not carry one. Every instruction is "left in 200
  metres". A name could be recovered from the *basemap* at the turn's coordinate, which is a
  lookup at a known point rather than a geocoder — a decision for the user, not a thing to slip
  in.
- **The surface strip is coloured by road class and the map marks only the exceptions.** Colour
  is free on a panel (`gradeScale.ts` records why) and spoken for on the map, which is the
  whole split. `chrome.test.ts` holds three deliberately *different* floors: ΔE **30** between
  cells, **13** against the gradient bands, **11** against the route colours. The 13 is a trade
  with its reasoning written down — a red clearing 15 from `very steep`, `brutal`, `mtb` and
  `recorded` does not exist, and crimson at h 15 is the only red in the window at all. Don't
  "tidy" the three to one number.
- **Categorical cells separate on chroma; a severity ramp separates on hue at held lightness.**
  The strip's first palette pinned all four at L\* 45.6, borrowing the second rule from
  `gradeScale.ts` where it is right, and scraped a worst pair of ΔE 27.4. Letting lightness vary
  buys **at most 1.6 ΔE** — the contrast window is only ~2:1 wide, so there is nowhere to go.
  Raising `path` from C 20.4 to 56.6 and moving `cyclepath` off the teal that sat beside the
  blue-grey `road` took it to 38.2. Reach for chroma first.
- **The breakdown table is the legend for the strip *and* for the map.** It sits directly under
  the strip — it was below the climb list, and a legend a scroll away from its subject is not a
  legend; climb ordering is a preference, legend adjacency is what makes the strip mean
  anything. Rows that produce a map mark carry a drawing of it in the route's own colour, which
  is what ties the map's texture to the strip's colour. Dragging the strip to highlight the map
  was tried on paper and measured out: the open sheet leaves ~110 px of map, so the stretch
  being pointed at is behind the sheet doing the pointing.
- **The opened riding panel has pages, and `hudAxis` arbitrates the two gestures.** Down
  resizes, sideways changes page, and **nothing is written until the first dozen pixels say
  which** — guessing on the first move nudges the panel's height at the start of every swipe,
  which is the "figures changing size while you read them" the panel already refuses on a tap.
  A diagonal tie goes to resizing. `hudPages` returns only the pages a ride has, so a recorded
  track has nothing to swipe to. **The graph keeps its own turn line**: the navigation page is
  the large version for a rider who asked for it, not a relocation, and moving it would mean
  anyone who stays on the graph loses the turn entirely.
- **A paged track needs its own clipping window.** `.hud-pages` exists because the panel clips
  at its *border* box while the layer inside carries 0.7rem of padding, so the outgoing page
  stopped 11 px inside the panel and showed a sliver of chart down the edge. The track was
  translating a full page width the whole time — measured, not guessed. A panel that is dragged
  sideways also needs `user-select: none`, or the first swipe selects the text it crosses. And
  the gesture must measure the **window**, not the panel: 341.6 px against 366 at a 390 px
  screen, or the page lags the finger and the release threshold sits 12 px out.
- **A two-axis gesture cannot test for a tap on one axis.** `wasTap(travelled)` measured only
  the vertical, so a clean sideways swipe read as a press and folded the panel instead of
  paging. Measure the displacement, and **suppress `.hud-collapse`'s click** once a gesture
  from it turns out to be a drag — that also fixes a vertical drag settling back where it
  started, which folded the panel on the click and predates the pages entirely.
- **`.hud-collapse` is off screen and must stay in the DOM.** It was a visible chevron on the
  panel's bottom edge and read as a control on a surface whose whole gesture is a drag. A
  keyboard, VoiceOver's activation and any synthetic press all arrive there as a click, and
  none of them can drag, so deleting it would strand the panel at whatever size it was last
  left. Clipped off-screen rather than `display: none`, which would take it out of the
  accessibility tree with the pixels. The page dots own the bottom edge now.
- **The graph page carries no turn line.** It had one, on the argument that a rider staying on
  the graph would otherwise lose the turn; riding it said otherwise. The graph page is the
  terrain, and a miniature turn on it competes with the page that does the job properly.
  Nothing is lost: folded, `calloutFor` still gives the strip the turn over the climb, and
  folded is where most of a ride is spent.
- **Every driver that rides must mute the app first.** Headless Chrome has a voice like any
  other, so a run announces each junction out loud into the room. `drive.mjs`,
  `drive-surface.mjs` and `onboarding-shots.mjs` all set `free-wheel.voice.v1` to `off` in
  their reset. None of them is checking the speech — `cues.test.ts` walks a real route for
  that.
- **A page the rider swiped to must never explain itself with a claim about the road.** The
  navigation page said "No turns ahead on this route" while off route and before the first fix,
  which is the flat-chart error in another costume: `turnAhead` is null in three states and only
  one of them is about the route. The map and the callout line may go quiet there because
  something else on screen is explaining; a page that is the whole surface cannot.
- **A near-black mark is invisible on the dark basemap.** The main-road mark began as a wider
  dark casing, which worked on light and vanished entirely on dark — every unit test green
  throughout. It is now flanking hairlines in the theme's overlay ink via `line-gap-width`, and
  it sits **above** the casing because at z16 the casing reaches 6.5 px where the flanks sit at
  4.25–6.25 and would be painted over.
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
- **Reverting a choice is a tap on the chosen line, not a tap anywhere.** It used to be any tap
  at all, justified by the pin toggle being on by default — and both halves of that have gone.
  With a stop now being a real point, the old order meant a rider who had chosen a route could
  not place one: the first tap silently un-chose it and the second shaped in a style they had
  not picked. So a tap on the chosen line means "not this one", a tap on another line means
  "that one", and a tap on the map is free to be the gesture the app is built on. A **lone**
  route re-chooses rather than reverting, so shaping a single route cannot lose it by touching
  it. `mapTapAction` owns the precedence and is tested — and note that its tests all passed
  while the rule was wrong, because they asserted the old one. Driving the app found it.
- **The plan card and the sheet it opens are one element, not two.** `--sheet-p` runs 0 at the
  card to 1 open and every difference between them is a `calc()` over it — the insets that make
  the card float, the bottom two radii, the height, the scrim. `useSheetDrag` writes the number
  straight to the element rather than through React state, because a re-render per frame of a
  tree holding three route cards and a chart is a dropped frame per frame. **vaul cannot do
  this**, which is the part worth remembering before reaching for it again: its snap points
  translate one full-height box, so the box always continues past the bottom of the screen and a
  minimised stop can be a bar but never an inset card. vaul still owns the Layers and finish
  sheets, which are modal with one stop each. Registering `--sheet-p` with `@property` is what
  makes it animatable at all; unregistered, the transition is a step and every `calc()` jumps.
- **Both of the sheet's content layers are laid out at a constant width**, each pushing back the
  edge the sheet is moving. Their measured heights are the two stops the sheet interpolates
  between, and the sheet is 24px narrower closed than open — so a layer whose width followed it
  would re-wrap its text and retarget, mid-flight, the animation it was halfway through.
- **The open sheet drags from its body, not only its handle.** Open, the card behind it is
  `inert`, so the handle was the only target — 60×24 px on the surface most used without looking.
  The handle now grows to the sheet's full width at the open stop, and a press in `.drawer-body`
  starts *pending*: nothing captured, nothing written, and `pendingVerdict` decides on the first
  dozen pixels between a drag, a scroll and a tap on the card under the thumb. Only from
  `scrollTop === 0`. The same shape is what makes the first run swipe (`swipe.ts`).
- **`.drawer-body` needs its own `touch-action: pan-y`.** `.plan-sheet` sets `touch-action: none`
  because it is dragged, and the comment beside it claimed the scroller handed `pan-y` back —
  no rule ever did. Invisible at a desk, where a wheel scrolls regardless; on a phone it is a
  route list that will not move.
- **The sheet's handle is a real button with a real `onClick`, and the pointer path stands aside
  for it.** A press arrives as a click from a keyboard, from VoiceOver and from any synthetic
  press. Handling the tap in the pointer release *as well* toggles twice and lands the sheet
  back where it started; `wasTap` in `sheetDrag.ts` is that one decision, and it is tested.
- **The `--panel*` translucency tokens live on `:root`, not `.ride`.** vaul portals the Layers
  and finish sheets to `<body>`, so anything scoped to the ride screen is invisible to them.
- **A pinned drawer footer is a sibling of the scroller, never `position: sticky` inside it.**
  Sticky cannot be pushed outside its containing block, and that block ends at the scroller's
  bottom padding — the home indicator's clearance. `Start ride` pinned itself `--safe-bottom`
  above the true bottom and the climb list scrolled through the strip beneath it; the negative
  bottom margin written to bleed past that edge was ignored by the clamp. It hides at a desk,
  where `env(safe-area-inset-bottom)` is 0 and the leak is 12 px rather than 46. `.sheet-full` is a
  flex column, so the footer just goes after `.drawer-body` — and then it needs no background,
  because nothing scrolls behind it.
- **Nothing may be positioned above the bottom bar by a constant, because there is no
  constant.** The plan card is an invitation, two coordinates or a routed summary, and the
  riding bar is one line or two. The OSM attribution — a licence requirement, so it has to be
  visible — sat across the route's own name for exactly this reason: `5.7rem` reserved against
  a card that measures 164 px. Whichever bar is up carries `data-bottom-bar`,
  `useBottomBarHeight` measures it and publishes `--bar-height`. Same argument as the HUD's
  measured height. The map buttons clear the plan sheet by that same measurement rather than by
  sitting above it in flow, because the sheet is fixed — it has to be, to reach the edges.
- **Setup must be reachable with a plan on the map.** Its only door used to be the plan card's
  shortcuts, which are the card's *empty* state — so placing one waypoint shut the rider out of
  the regions, the rider settings and diagnostics until they cleared the plan. It is a row at
  the foot of the Layers sheet as well now. That sheet is the ride screen's surface for things
  you set rather than things you do, and it is behind a button that never leaves the map.
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
- **Setup is built from the ride screen's tokens, and a setting is a row.** It is one of the
  app's *document* surfaces — Saved is the other, and both are full screens rather than drawer
  views — so it is the easy place to drift into browser defaults — which is exactly
  what happened: 17px prose, a `<dl>` with a 9rem label column, bare `<button>`s at a radius
  nothing else uses. The vocabulary is in `App.css`: `.setup-group` holds `.setup-row`s (label
  left, value right, note under), explanation goes *below* a group as `.setup-footer` in the
  muted size, group headers are sentence case, and separation is an inset hairline ring — there
  are only the four shadows in `tokens.css`, and there is no fifth.
- **A class that clears `border` and `background` does not clear `box-shadow`.** `App.css` gives
  every `button` a hairline ring, so `.picker-plain` — which only reset the first two — left
  every quiet text button in Setup outlined and hanging off the left margin. If you add a
  property to the element rule, add its reset to the quiet classes.
- **A class name with no rule behind it fails silently and looks like a spacing bug.**
  `RiderPanel` marked three paragraphs `.step-note` and no stylesheet ever defined it, so they
  rendered at full body size and outweighed every heading on the screen. That was most of what
  "Setup doesn't feel like the rest of the app" was. Grep the CSS before trusting a class name.
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
- **Regions are painted *under* the basemap's water, and that is what clips them to the coast.**
  `regionLayers.ensureRegionLayers` inserts its fills and divides before the first `water` role
  layer. Water is opaque, so it renders in MapLibre's opaque pass and writes depth; the region
  fills are translucent and fail the depth test behind it. The shapes themselves are
  square-cornered blocks running well out to sea and none of that is ever seen — so nothing has
  to know where the coast is, and it stays right in both themes at every zoom. `fill-antialias`
  must be **false**: it outlines every ring, which would trace each merged rectangle in the fill
  colour and put the grid back on screen.
- **A region's painted area comes from a written-down seed, not from its bbox.** The published
  boxes are download extents with generous, asymmetric overlap, so no measurement of them
  recovers which region a place *belongs* to. Nearest box centre painted the Central Belt as the
  Borders; deepest-inside-the-box then put Manchester in Yorkshire, Hull in East Anglia and
  Carlisle in Scotland. `regionShapes.REGION_SEEDS` names the heart of each region and a cell
  goes to the nearest seed **among the regions whose box covers it** — the clip is what keeps it
  honest, since a seed can only redistribute published coverage, never invent it. A long region
  needs two seeds. The first seed is also where the name is drawn.
- **There is no fourth region colour, and this has been checked.** A sweep of the RGB cube for a
  colour at C >= 46 clearing ΔE 16 from both basemap palettes, the three existing region colours
  and the six route colours returns nothing — the usable circle is full. So the divides, the
  selected ring and the region names are achromatic by theme, and a region in flight keeps the
  `available` blue. Fills are 0.30 / 0.44 / 0.62 only because the partition removed the overlap;
  under the old boxes alpha compounded fourteen deep and 0.06 was the most Britain could take.
- **MapLibre places symbols top down, so the topmost symbol layer wins a collision.**
  `PauseablePlacement.continuePlacement` counts the layer order *down* from the end. The region
  names are therefore the last layer added; moving them under the basemap's own labels, on the
  theory that placement ran bottom-up, took the count of names actually drawn from 13 to 10.
  Collisions are also why the map uses `REGION_SHORT_NAMES` below z6.5 and `text-padding: 2` —
  padding *is* collision margin, and a dropped label leaves an area with no name at all.
- **A region divide is drawn twice, once by each side, so a dash cannot read as gaps.** The
  neighbour's hairline sits in them. An in-flight region separates on the *weight* of its divide
  (3 px at 0.9 against 1 px at 0.4) as well as the dash. Keep the dash data-driven on **both**
  line layers: as its own layer it drew under the selection ring, so a region downloading because
  the rider had just tapped it looked exactly like one sitting still.
- **The two ride overlays are achromatic, and that is a rule not a preference.** Six route hues
  at C ≥ 45 already fill the usable circle under the ΔE ≥ 16 clearance floor. "Already ridden"
  is neutral grey — it has stopped being a route — and "climb ahead" is a blurred halo in black
  or white by theme, which is a *lightness* effect and so needs no clearance rule and works
  over a line of any colour. Do not give either one a hue.
- **One level, one way back.** Saved's detail used to draw a `‹ Saved` button of its own an inch
  under the header's `‹`, and the two did different things — the inner one to the list, the
  outer one straight to the map. `SavedScreen` owns `openId` now, and its one arrow goes to
  whichever is behind. A screen's header is where the way out lives; a view inside it does not
  get a second.
- **A list row's card belongs to the button, not to the `<li>`.** Saved's rows became one
  `.library-row` button when the library was promoted to a screen, and the `52px 1fr` grid left
  on the `<li>` went on placing that whole button in a 52px column — figures wrapped to three
  lines, chevron across them, and the white box that read as a frame around the thumbnail was
  the row itself, squeezed. When a row's contents become one element, the `<li>` styles nothing.
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
- **iOS shake-to-undo cannot be refused, so the riding screen carries no text field.** A bike
  on rough ground performs the gesture continuously, and WebKit offers a page no way to decline
  the "Undo Typing" alert — there is no cancellable event. The only lever is an empty undo
  stack, so a finished ride saves itself under its generated name and renaming happens in the
  library. **Unmounting a field does not empty the stack**: WebKit keeps the typing after the
  element has gone, so a destination typed into search before Start brought the alert back.
  `clearUndoStack` (`src/ride/undoStack.ts`) empties it as a ride begins, by inserting and
  removing an iframe — a frame detaching is the one path by which WebKit clears the page's undo
  stack. `RideView` also refuses `beforeinput` with `inputType: 'historyUndo'` while riding,
  which does not stop the alert but stops it quietly reverting something off screen. The user's
  own escape hatch is Settings → Accessibility → Touch → Shake to Undo.
- **A recorded ride is not BRouter GPX, and must not be read as if it were.** It carries no
  `track-length` summary, so `parseBrouterGpx` reports a route of length zero that the progress
  bar then divides by. `parseTrackGpx` measures the distance from the track instead, and sums
  ascent through the shared `ascent.ts` — one deadband constant, or the stats rail and the climb
  list disagree about the same hill.
- **A recorded track has heights only where it was following a route.** `RouteGeometry.hasElevation`
  (and `hasHeights()` for a parsed route) is the gate: where it is false, the power column, the
  lookahead graph, the elevation profile and the climb list are all *removed* rather than drawn
  from zeros. A flat bar chart is not "no data" — it is a claim that the road ahead is level.
- **`plan.chosen` can name something the engine cannot route.** Following a recorded track sets
  it to the `recorded` pseudo-profile, which is deliberately not in `PROFILES`. Anything that
  asks the engine for a profile must use `plan.rerouteProfile`, which falls back to the ticked
  selection — otherwise a reroute fails at the exact moment a lost rider needs it. `style.test.ts`
  iterates `ROUTE_PALETTE`, not `PROFILES`, so the extra colour is still held to the ΔE floor.
- **The riding HUD is dragged between its two sizes, and it is the plan sheet upside down.**
  `--hud-p` is 0 on the strip and 1 on the graph; `useHudDrag` writes it and the height, both
  layers' opacity and the chevron's rotation are `calc()`s over it. Pull down to open, push up
  to fold — the whole surface is the target, because nothing on it is interactive. **A tap
  anywhere but the chevron deliberately does nothing** (`hudDrag.ts`): unlike the sheet's
  handle, this surface is where a hand lands coming back to the bars, and a toggle on contact
  would resize the figures being read. The chevron is centred on the bottom edge, is a real
  button, and is the way in from a keyboard or VoiceOver.
- **The HUD's two layers hand over; they do not blend.** A straight cross-fade was tried and is
  wrong here: the strip is three figure columns and the graph is four, so at half opacity each
  "93 km" is printed twice an inch apart. Each layer is scaled and offset to be gone by the
  half-way point and to start from it.
- **The riding HUD's height is measured, not guessed.** Both sizes are absolutely positioned
  layers, and a `ResizeObserver` on each publishes `--hud-mini` and `--hud-full`. A hard-coded
  collapsed height does not work: the climb line appears and disappears inside the strip, so the
  strip's own height is not constant. `data-measured="no"` suppresses every transition until a
  frame *after* the first measurement — a transition's properties are read from the
  after-change style, so setting the real heights and the flag in one recalculation animates
  the panel from the stylesheet's guess on arrival. This is the one place the "don't animate a
  backdrop-filtered box's height" rule is knowingly broken — one panel under a deliberate
  finger, not seven blurred buttons once a second.
- **The rider's marker has two sizes and is switched by `setPositionEmphasis`.** One size served
  both screens and measured 20 logical pixels on the road, which is a street label. Riding is
  45 px of arrow over a 34 px halo; the arrow is drawn at 64 device pixels and scaled *down*,
  and carries a white ring inside a dark hairline so one image works over both basemaps without
  a repaint on a theme swap.
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
