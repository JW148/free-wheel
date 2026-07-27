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
brouter-link/    Read-only symlink to upstream BRouter. See above.
docs/            Spike results and findings.
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
```

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

`web/public/engine/` is generated and gitignored — regenerate it with the Gradle commands above
rather than editing anything in it.

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
  module, not per-instance.
- **Precache glyphs and sprites in the service worker.** PMTiles archives do not contain them
  and MapLibre fetches them separately; skipping this yields an offline map with no labels,
  which looks like a styling bug.
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
  therefore share one registry in `opfsVfs.ts` — never open handles elsewhere.
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

## Verification

Desktop Safari and the Simulator both diverge from real devices on storage and Wake Lock
behaviour. **On-device testing on a real iPhone, added to Home Screen, is non-negotiable** before
calling anything done. The acceptance test is: airplane mode, cold launch, plan a route, follow
it.
