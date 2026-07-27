# Handoff

Written 2026-07-26, updated 2026-07-27. Read `CLAUDE.md` first for the rules of the repo, then
this for where the work actually stands.

`brouter-link/` is correctly excluded from git and its own checkout is clean; verify with
`cd brouter-link && git status --porcelain` (should print nothing).

## Where things stand

| | Status |
|---|---|
| **Spike 1** — TeaVM toolchain | ✅ Passed, verified on a physical iPhone |
| **Phase 1** — Wasm engine + OPFS VFS | ✅ Passed, verified on a physical iPhone |
| **Phase 2** — worker harness, tiles | ✅ Complete, import verified on device |
| **Phase 3** — React/MapLibre PWA | 🟡 **Basemap renders with labels, offline** on desktop; not yet on device. Map UI outstanding |
| **Spike 2** — OPFS durability | ⏸ Deliberately deferred by the user |

Detail lives in `docs/spike-1-results.md`, `docs/phase-1-progress.md`,
`docs/phase-2-progress.md`, `docs/phase-3-progress.md`. Each records what was measured, and —
more usefully — where the original plan turned out to be wrong.

### The headline results, so they are not lost

- **BRouter compiles to WasmGC unmodified.** 1.22 MB / 399 KB gzip.
- **GPX is byte-identical to the JVM on 9/9 reference routes**, including three that cross a
  tile seam. This is the regression net; keep it green.
- **On an iPhone:** 76 km route in 4.5 s (2.7× the desktop JVM). 150 km extrapolates to ~18 s.
- **JSC's floating point matches HotSpot bit-for-bit**, which is what makes byte-identical GPX
  viable at all.

## The question that was open — and its answer

**The map now renders.** It was never the OPFS pipeline, and it was never the preview browser.

MapLibre GL JS 6 ships its worker as a separate file and locates it from `import.meta.url` at
runtime, so once bundled it asked for `/assets/maplibre-gl-worker.mjs` — never emitted. Every
source type is parsed in the worker pool, which is why OPFS-backed PMTiles, HTTP-backed
PMTiles and a plain inline GeoJSON source all failed identically. Two things hid it: the dev
server's SPA fallback served `index.html` with a `200` for the missing script, and MapLibre's
try/catch around `new Worker` cannot catch an async parse failure. No 404, no error event, no
console output.

Fixed in `src/map/maplibreWorkerEntry.ts` + `src/map/maplibreWorker.ts`. Full write-up, and the
two follow-on traps (tree-shaking emitting a 0-byte worker chunk; the missing `declare module`),
in `docs/phase-3-progress.md`.

Measured on desktop:

```
stages: dataloading → source loaded → load
OPFS reads 6, 621 kB
2608 features: boundaries 8, roads 565, roads-casing 567, water 31, landuse 1433, earth 4
```

**Next action: the same check on a physical iPhone**, per the standing rule that desktop proves
nothing about the device. The panel's diagnostics are deliberately still in place for it,
including a `worker ok:` / `worker BROKEN` line that fetches the worker URL and checks the
content type — the status code was `200` in the broken case, so the content type is the tell.

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
- `data/basemap/london.pmtiles` — 35 MB, built by `pmtiles extract`

Re-fetch the `.rd5` files from `https://brouter.de/brouter/segments4/`. Rebuild the basemap:

```bash
~/bin/pmtiles extract https://demo-bucket.protomaps.com/v4.pmtiles data/basemap/london.pmtiles \
  --bbox=-0.35,51.35,0.15,51.65 --maxzoom=14
```

That took 2.6 s and transferred 37 MB out of a 137 GB remote archive — ranged reads work
exactly as the plan promised.

## Running it

```bash
cd engine
./gradlew syncProfiles                       # cycling profiles -> web/public/profiles2
./gradlew jvmRoutes                          # regenerate the GPX reference corpus
./gradlew buildWasmGC generateJavaScript     # the engine
./gradlew buildWasmGC -PwasmDebug            # ...with Java names in stack traces

cd ../web
npm run build
npm run spike-server -- 4174                 # http, for desktop (localhost is a secure context)
npm run spike-server-https                   # https on 4173, required for any device test
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

1. **See the basemap render on the phone** (above). Then remove the `window.__map` debug hook
   and thin the diagnostics in `MapPanel.tsx` — but keep the `worker ok:` check, which is
   cheap and guards a failure mode that is invisible without it.
2. **Map UI** — waypoints, drag to reshape, profile picker, route rendering, GPX export.
   `Router.route()` already returns GPX; `FormatJson` in brouter-core would give GeoJSON more
   directly for rendering.
3. Foreground following (`watchPosition` + Screen Wake Lock), and re-derive elapsed time on
   resume — iOS suspends timers when backgrounded.
4. Spike 2 (durability) whenever the user wants it. Note their reasoning was "256 GB phone",
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
