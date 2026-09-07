# Handoff

Written 2026-07-26, updated 2026-09-06. Read `CLAUDE.md` first for the rules of the repo, then
this for where the work actually stands.

`brouter-link/` is correctly excluded from git and its own checkout is clean; verify with
`cd brouter-link && git status --porcelain` (should print nothing).

## Where things stand

| | Status |
|---|---|
| **Spike 1** — TeaVM toolchain | ✅ Passed, verified on a physical iPhone |
| **Phase 1** — Wasm engine + OPFS VFS | ✅ Passed, verified on a physical iPhone |
| **Phase 2** — worker harness, tiles | ✅ Complete, import verified on device |
| **Phase 3** — React/MapLibre PWA | ✅ Basemap renders with labels, offline |
| **Phase 4** — the ride UI | 🟡 **Plan and follow works end to end**; verified on desktop and booted on the iOS Simulator. **Ridden 2026-09-06** |
| **Phase 5** — basemap legibility | 🟡 Land cover, water and rail restyled after the ride. Tests green, not yet ridden |
| **Spike 2** — OPFS durability | ⏸ Deliberately deferred by the user |

Detail lives in `docs/spike-1-results.md`, `docs/phase-1-progress.md`,
`docs/phase-2-progress.md`, `docs/phase-3-progress.md`, `docs/phase-4-progress.md`,
`docs/phase-5-progress.md`. Each
records what was measured, and — more usefully — where the original plan turned out to be
wrong.

### The headline results, so they are not lost

- **BRouter compiles to WasmGC unmodified.** 1.22 MB / 399 KB gzip.
- **GPX is byte-identical to the JVM on 9/9 reference routes**, including three that cross a
  tile seam. This is the regression net; keep it green.
- **On an iPhone:** 76 km route in 4.5 s (2.7× the desktop JVM). 150 km extrapolates to ~18 s.
- **JSC's floating point matches HotSpot bit-for-bit**, which is what makes byte-identical GPX
  viable at all.

## Where to pick up

**The next action is a ride, in daylight.** The first ride (2026-09-06) worked but produced one
dominant complaint: the map was too monochromatic to orient by. Phase 5 fixed that — the
archive already carried 43 distinct land kinds and the style was painting all of them one
colour, at ΔE 2.4 from the earth beneath them. Land cover, water and railways are now
restyled and every palette rule is asserted in `style.test.ts` rather than written down.

What needs riding: **the light theme in direct sunlight.** That is the condition the light
palette exists for and the one a desk and a Simulator cannot reproduce. Two things the rider
asked for were deliberately *not* done — building footprints (2.6× archive size, declined) and
an OpenCycleMap-style cycle network (impossible from this data — see below).

The acceptance test, unchanged: airplane mode, cold launch from the Home Screen, plan a route,
follow it.

What is known to work, and where:

- **Desktop** — basemap, waypoints, routing, stats, GPX export, persistence across a cold
  reload. Edinburgh → Dalkeith on `trekking` returns 12.3 km / 40 min / 98 m, matching the GPX
  header exactly.
- **iOS 26.5 Simulator** — the app boots to the empty state, which is only reachable once
  `init()` resolves. That means the WasmGC engine loads, profiles provision into OPFS, and the
  VFS installs on real iOS WebKit. Nothing past that was exercised, because pushing a 34 MB
  archive through the Files picker in a Simulator is not scriptable.
- **Never** — wake lock (needs a home-screen PWA on iOS 18.4+), follow mode against a moving
  fix, and peak memory during routing.

Detail and the reasoning behind the phase's design choices are in `docs/phase-4-progress.md`.

## Deployment

`vercel.json` at the repo root builds `web/` and serves `web/dist`. Static, no env vars, no
backend — there is nothing to configure.

This is why **`web/public/engine/` and `web/public/profiles2/` are now committed** despite
being generated: building them needs JDK 21, Gradle, and the `brouter-link` symlink to a
separate local checkout, and a static host's build machine has none of those. Only the
`-PwasmDebug` sidecars (`.wasm.map`, `.teadbg`, the deobfuscator, `wasm-gc/src/`) stay
ignored. Regenerate with Gradle and commit the result; do not hand-edit.

**The data files are still not deployed, and must not be.** `.rd5` and `.pmtiles` go on the
phone by hand — see *Tiles are import-only* below. Getting them there:

1. AirDrop `data/segments4/W5_N55.rd5` and `data/basemap/edinburgh.pmtiles` from this Mac.
2. Save to Files on the phone.
3. In the app: Setup → Maps and data → import each one.

## Environment — the parts that will waste your time

**Java is not on PATH.** `openjdk@21` is keg-only, so a bare `java` hits the macOS stub and
fails. `~/.zshenv` exports `JAVA_HOME`; that is what makes it work. If it breaks:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

Two related traps: zsh reads `~/.zshenv` (not `~/.zshrc`) for non-interactive shells, and
Homebrew here belongs to `joeadmin` while builds run as `jwig` — a profile written to the admin
account has no effect.

**Other tools installed outside the repo:**

- `~/bin/pmtiles` — the PMTiles CLI (v1.31.2), used to build basemap extracts.
- `web/certs/` — a local CA and server cert (gitignored). Regenerate with
  `web/tools/make-certs.sh`. The CA is already trusted on the test iPhone.

**Large files not in git** (`data/` is gitignored):

- `data/segments4/W5_N50.rd5` — 137 MB, southern Britain
- `data/segments4/E0_N50.rd5` — 78 MB, Kent/Belgium, for cross-tile tests
- `data/segments4/W5_N55.rd5` — 26 MB, central Scotland; Edinburgh lives here
- `data/basemap/london.pmtiles` — 35 MB, built by `pmtiles extract`
- `data/basemap/edinburgh.pmtiles` — 34 MB, bbox `-3.85,55.65` to `-2.55,56.20`

Re-fetch the `.rd5` files from `https://brouter.de/brouter/segments4/`. Rebuild a basemap:

```bash
~/bin/pmtiles extract https://build.protomaps.com/20260906.pmtiles data/basemap/edinburgh.pmtiles \
  --bbox=-3.85,55.65,-2.55,56.20 --maxzoom=14
```

36 MB transferred for a 34 MB archive, in 16 s. Ranged reads work exactly as the plan promised.

**The source URL in the original plan is dead.** `https://demo-bucket.protomaps.com/v4.pmtiles`
now 404s. Use the dated daily builds at `https://build.protomaps.com/YYYYMMDD.pmtiles` — and
note they expire, `20260801` already 404s, so pick a recent date.

## Running it

```bash
cd engine
./gradlew syncProfiles                       # cycling profiles -> web/public/profiles2
./gradlew jvmRoutes                          # regenerate the GPX reference corpus
./gradlew buildWasmGC generateJavaScript     # the engine
./gradlew buildWasmGC -PwasmDebug            # ...with Java names in stack traces

cd ../web
npm run build
npx vitest run                               # gpx.ts unit tests
npm run spike-server -- 4174                 # http, for desktop (localhost is a secure context)
npm run spike-server-https                   # https on 4173, required for any device test
```

The iOS Simulator reaches the Mac's `localhost` directly, and `http://localhost` is a secure
context — so unlike a physical device it needs no HTTPS and no trusted CA:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
SIMCTL=$DEVELOPER_DIR/usr/bin/simctl          # xcode-select points at CommandLineTools here,
$SIMCTL list devices available                # where simctl does not exist at all
$SIMCTL boot <udid>
$SIMCTL location <udid> set 55.9533,-3.1883   # Edinburgh, for follow mode
$SIMCTL openurl <udid> http://localhost:4174/
$SIMCTL io <udid> screenshot /tmp/sim.png
```

Two servers because **OPFS needs a secure context**: `navigator.storage` is `[SecureContext]`,
so on a plain-HTTP LAN origin it is `undefined`. `http://localhost` counts as secure, which is
why desktop never hits this and the phone always does.

The dev server also serves `/segments4/` and `/basemap/` — **the app never fetches these**.
They exist so a fixture can be pulled onto a test device without re-downloading from brouter.de.

## Decisions that should not be quietly undone

1. **`brouter-link/` is read-only.** Sources are *copied* to `engine/build/brouter-src` and
   patched there. Three substitutions are declared in `engine/build.gradle`, and **each asserts
   it applied**, so an upstream change fails the build rather than silently reverting. Never a
   Gradle composite build — that writes into the linked checkout.

2. **Tiles are import-only.** The app has no downloader, by the user's explicit decision. Do
   not add one; `brouter.de` sends no CORS header anyway, so a browser could not fetch from it.
   A working `Range`/`If-Range` resumable downloader was built and then deleted — it is in the
   git history of this working tree only if you commit first.

3. **One engine, one handle registry.** `sharedEngine()` is a singleton because OPFS permits
   exactly one open sync access handle per file. Two `EngineClient`s means two Workers means a
   collision. This was a real bug, found when two panels finally coexisted.

4. **The recursion cap is load-bearing.** `OsmNodesMap.minVisitIdInSubtree` is bounded at 200
   frames. WasmGC cannot represent stack exhaustion as `StackOverflowError` — it arrives as a
   JS `RangeError` that unwinds past even `catch (Throwable)` — and BRouter *relies* on catching
   it. Verified not to change routing: the corpus is byte-identical with and without.

5. **We do not vendor `@makina-corpus/maplibre-offline-pmtiles`**, despite the plan suggesting
   it. It opens its own OPFS handles and would collide as in (3). `src/map/opfsPmtiles.ts`
   implements the `pmtiles` `Source` interface against the existing registry instead.

## Traps that have already cost time

- **The service worker serves stale bundles.** Fixed with `skipWaiting`/`clientsClaim`, but
  always confirm the `build:` timestamp in the Environment panel before trusting a device
  result. Three separate debugging sessions were wasted on this.
- **Stack-depth probes overestimate.** A trivial probe reported 25,179 frames on device where
  the real function overflowed past 2,000. Capacity is bytes, not frames.
- **`pmtiles` silently substitutes a network `FetchSource`** when it does not recognise an
  archive key, turning a wiring mistake into a hang rather than an error. The protocol
  registration is wrapped to log this.
- **`input.files = dt.files` empties the DataTransfer**, so reading it afterwards reports zero
  files. That is a test-harness gotcha, not a bug.
- **An SPA fallback turns a missing asset into a `200` of HTML.** That is how the MapLibre
  worker went missing for a whole phase without a single 404. `tools/report-server.mjs` now
  404s anything under `/assets/` or with a build-artefact extension; keep it that way.
- **macOS firewall blocks inbound to `node`**, and `jwig` is not in the `admin` group so `sudo`
  is unavailable. Already allowed, but it will recur after a node upgrade.

## Suggested order from here

1. **Ride with it, in daylight.** Everything else is speculation until then. Phase 5 changed
   what the map looks like and nothing else; the acceptance test is unchanged.
2. **If cycle infrastructure still reads as the gap**, that is a data problem, not a styling
   one. Protomaps carries no `route=bicycle` relations and stamps `min_zoom: 14` on cycleways,
   so nothing exists below z14 and NCN numbers exist nowhere. It needs a planetiler pipeline
   producing a cycle-only PMTiles overlay — a new subsystem, scoped out of phase 5 on purpose.
   Details in `docs/phase-5-progress.md`.
3. Re-derive elapsed time on resume — iOS suspends timers when backgrounded, so any
   ride-duration display computed by accumulating ticks will drift. Nothing currently shows
   elapsed time, which is why this has not bitten yet.
4. Turn-by-turn, if the ride shows it is wanted. BRouter already computes voice hints;
   `FormatGpx` emits them under several `turnInstructionMode` values.
5. Spike 2 (durability) whenever the user wants it. Note their reasoning was "256 GB phone",
   which reduces but does not eliminate the risk: WebKit also evicts under overall system
   storage pressure, not only quota exhaustion.

## Loose ends worth knowing

- Peak memory during routing has never been measured; the plan wants it under ~300 MB.
- OPFS write throughput on device was never captured as a number — import works, but nobody
  timed 137 MB.
- The staleness warning on imported tiles compares against `tile-catalogue.json`, a build-time
  snapshot. If `npm run build-catalogue` goes unrun for months the warnings themselves go stale.
- `docs/spike-runs/` is gitignored; device reports land there via the **Send report** buttons,
  which POST to the dev server.
- The iPhone's UA is internally inconsistent (`iPhone OS 18_7` with `Version/26.5.2`). The real
  iOS version was never confirmed from Settings, and it matters for the Wake Lock baseline
  (iOS 18.4+) and for Spike 2.
