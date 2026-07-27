# Phase 1 — The Wasm engine

**Status: PASSED, on a physical iPhone. BRouter routes out of OPFS in a home-screen PWA and
produces byte-identical GPX to the JVM on all six reference routes.**

## Done

### The VFS gate passed — BRouter compiles unmodified

The plan's central claim was that BRouter needs no fork because TeaVM implements
`RandomAccessFile` over a pluggable filesystem SPI. Verified before building anything on it:

- The SPI is real, in **`teavm-core`** (not `teavm-classlib`), as
  `org.teavm.runtime.fs.{VirtualFileSystem, VirtualFile, VirtualFileAccessor}` with exactly
  the `{read, write, tell, seek, skip, size, resize, close, flush}` shape the plan described.
- `TRandomAccessFile` → `TFile.findVirtualFile()` → `VirtualFile.createAccessor()` →
  `VirtualFileAccessor.seek/read`. Backend-agnostic classlib code, not C-backend-only as the
  neighbouring `backend/c/runtime/fs` package might suggest.
- `btools.wasm.VfsProbe` confirms it *runs* on WasmGC: writes a file, reads an interior slice
  back via `seek` + `readFully`, and checks the bytes are the ones written (a VFS ignoring
  `seek` would still return data of the right length). Identical CRC on WasmGC and JS.
  `File.exists/isFile/length/lastModified` all work too.

### The whole routing engine compiles to WasmGC

`brouter-util`, `-codec`, `-expressions`, `-mapaccess`, `-core` — 121 classes. Confirmed zero
third-party runtime dependencies, as the plan said.

**Artifact size — this finally tests the 1–2 MB estimate, and it holds:**

| File | Raw | gzip |
|---|---|---|
| `brouter-wasm.wasm` | **1,200,550** (1.20 MB) | **393,956** (394 KB) |
| `brouter-wasm.wasm-runtime.js` | 16,425 | 5,775 |
| `brouter-wasm.js` (JS backend) | 749,857 | 233,927 |

Spike 1's 23 KB artifact told us nothing about this; 1.20 MB raw / 394 KB over the wire is
comfortably within estimate and a non-issue for a PWA that already downloads 137 MB tiles.

### Real routes, on the JVM, through the code the browser will call

`Router.routeIn()` is the single implementation; `Router.route()` (exported to JS) supplies the
OPFS paths, and `JvmRouteMain` supplies real filesystem paths. Byte-identical GPX only means
something if both sides run the same code, so there is deliberately no second JVM harness that
reimplements the setup.

| Case | Profile | JVM | GPX bytes | CRC-32 |
|---|---|---|---|---|
| `urban-short` | trekking | 175 ms | 8,624 | 266934936 |
| `urban-medium` | trekking | 196 ms | 19,579 | 837626376 |
| `fastbike-medium` | fastbike | 227 ms | 23,800 | 2026425749 |
| `shortest-medium` | shortest | 111 ms | 20,978 | -133505748 |
| `gravel-medium` | gravel | 143 ms | 19,211 | 3435212 |
| `london-brighton` | trekking | **1,646 ms** | 235,640 | 1869357118 |

Output is genuinely real BRouter: `creator="BRouter-1.7.10"`, 3,543 trackpoints and a
94,981 m route for `london-brighton`, with elevation. Four profiles over the *same* waypoints
give four different CRCs, which proves the `.brf` cost function is really being read and
applied rather than ignored — the profile language being the whole reason for this port.

CRCs reproduce exactly across runs and across a profile-directory regeneration.

### Early read on Spike 3's perf question

**76 km air-distance routes in 1.65 s on the JVM.** Spike 1 measured the iPhone at ~2× the
desktop JVM, which would put that route near ~3.3 s on device. Extrapolating the documented
quadratic cost, 150 km (≈4× the work of 76 km) lands around 6.6 s JVM / ~13 s on device.

That is usable, and it suggests the plan's 150 km ceiling — inherited from 2011-era Android —
is pessimistic. Treat this as an indication, not a measurement: it is one route, the
extrapolation assumes clean quadratic scaling, and peak memory is not yet instrumented.

## Corrections to the plan

1. **"Exclude `btools.util.StackSampler`" is not achievable by exclusion.** `RoutingEngine`
   imports it, declares a field of its type, and constructs it at `RoutingEngine.java:128`, so
   TeaVM's reachability analysis pulls it in whether or not it ever executes. It needs three
   things TeaVM lacks: `Thread.getAllStackTraces()`, `Thread.getState()`, and
   `java.util.Locale$Builder`. It must be **substituted**, not dropped.

2. **`OsmTrack` has an untranslatable static initialiser the plan did not anticipate.**
   `OsmTrack.java:26` is `public static String version = OsmTrack.class.getPackage().getImplementationVersion()`,
   and TeaVM's `java.lang.Package` has no such method. It is not cosmetic: `FormatGpx` writes
   it into the GPX header as `creator="BRouter-<version>"`, so it must be both translatable and
   *stable*, or GPX parity fails on the first line of every file.

3. **`@JSExport` is not enough for a non-main class.** Methods are only exported from the class
   named by `mainClass` unless the class is listed in `@JSExportClasses`. `preservedClasses` in
   the Gradle DSL keeps a class from being dead-code-eliminated but does **not** export it —
   both are needed.

4. **Segment tiles are much larger than "median 1.2 MB" implies for populated areas.**
   `W5_N50.rd5` (Britain south of 55°N) is **137 MB**; `E0_N50.rd5` is 78 MB. The median is
   dominated by ocean and empty tiles. Region-picker UX should quote real sizes, not the median.

## How the substitutions work

BRouter's sources are **copied** into `engine/build/brouter-src` by `prepareBrouterSources` and
compiled from there, rather than compiled in place. `brouter-link/` is never written to.

Two kinds of change, both declared at the top of `engine/build.gradle`:

- **`sourceSubstitutions`** — files excluded from the copy, with a replacement in
  `engine/src/main/java`. Currently `btools/util/StackSampler.java`, replaced by a documented
  no-op. Safe because construction sits behind `infoLogEnabled` (`outfileBase != null`, and we
  always pass `null`, as the Android app and brouter-server both do) *and* behind a
  `stacks.txt` file existing.
- **`sourcePatches`** — single-expression rewrites. Currently two:
  - `OsmTrack`'s version expression → the literal version string, read from upstream's own
    `brouter.version-conventions.gradle` so it tracks `brouter-link` instead of drifting.
  - `OsmNodesMap.minVisitIdInSubtree` → depth-bounded, throwing the `StackOverflowError`
    upstream already catches (three co-ordinated replacements). See Correction 5.

Every patch is **asserted to have applied**. If upstream changes the line, the build fails
loudly rather than silently reverting to untranslatable code. That is the property that makes
this safe to carry across upstream merges — which was the whole point of not forking.

Both the WasmGC build and the JVM reference build compile these same outputs, so a substitution
applies to both sides and GPX parity stays true by construction.

## The OPFS filesystem

`OpfsVirtualFileSystem` + `OpfsVirtualFile` + `OpfsVirtualFileAccessor` (Java) sit on top of a
synchronous JS bridge (`web/src/engine/opfsVfs.ts`). The division of labour is forced by the
APIs: the SPI is entirely synchronous while every OPFS *opening* call returns a Promise, and
synchronous Java cannot await. So JavaScript does all the async work up front — walk
directories, stream downloads, open one `FileSystemSyncAccessHandle` per file — and afterwards
answers questions synchronously.

Consequences worth knowing:

- **Handles stay open for the session.** Acquiring one is async, so a synchronous `read()`
  could never reopen a closed handle. `close()` on the accessor is therefore a no-op —
  BRouter opens and closes segment files freely, and closing the real handle would make the
  next read unserviceable.
- **Read-only.** Nothing in the routing path writes (`outfileBase`/`logfileBase` are `null`),
  and provisioning happens in JS. Write methods throw rather than no-op, so a future need
  announces itself.
- **`lastModified` is a constant.** `probeFileMetadata` confirmed TeaVM otherwise returns wall
  clock, and `ProfileCache` invalidates on it, which would re-parse the profile every route.
- **Reads reuse one scratch buffer.** Safe because the Java side copies out via
  `copyToJavaArray()` synchronously with no await in between. A 137 MB tile is read in
  thousands of chunks, so per-read allocation would just move the work to the GC.

**The VFS was verified independently of BRouter** before trusting it, using `VfsProbe.probeRead`
through `java.io.RandomAccessFile`:

| file | via OPFS + WasmGC | expected (JVM) |
|---|---|---|
| `trekking.brf` | 17852 bytes, crc `-1390034577` | 17852, `-1390034577` |
| `lookups.dat` | 31604 bytes, crc `-342624937` | 31604, `-342624937` |

That mattered: the next failure looked like a filesystem bug and was not one.

## GPX parity — 6/6 byte-identical, in a browser, out of OPFS

Chromium 146, WasmGC, reading `.rd5` and `.brf` from OPFS; JVM column is the same code on the
same machine.

| Route | JVM | WasmGC | Ratio | GPX bytes | CRC-32 |
|---|---|---|---|---|---|
| `urban-short` | 189.3 ms | 140.8 ms | **0.74×** | 8,624 | 266934936 ✅ |
| `urban-medium` | 220.5 ms | 252.8 ms | 1.15× | 19,579 | 837626376 ✅ |
| `fastbike-medium` | 220.7 ms | 318.0 ms | 1.44× | 23,800 | 2026425749 ✅ |
| `shortest-medium` | 113.1 ms | 181.4 ms | 1.60× | 20,978 | -133505748 ✅ |
| `gravel-medium` | 149.6 ms | 241.3 ms | 1.61× | 19,211 | 3435212 ✅ |
| `london-brighton` | 1,609.9 ms | 3,068.6 ms | 1.91× | 235,640 | 1869357118 ✅ |

**76 km routes in 3.07 s in a browser.** Applying Spike 1's measured ~2× device factor puts
that near 6 s on the iPhone; extrapolating the quadratic cost, 150 km would be roughly 4× the
work, so ~25 s on device. Slower than the earlier back-of-envelope estimate but still usable,
and the 150 km figure remains a ceiling rather than a target.

Note the ratio grows with route length (0.74× → 1.91×), which is consistent with the larger
searches spending proportionally more time in allocation-heavy graph code where WasmGC is
weaker relative to HotSpot, and less in the tight loops where it matches.

## Correction 5 — the one that actually blocked Phase 1

**WasmGC cannot surface stack exhaustion as `java.lang.StackOverflowError`, and BRouter
depends on being able to catch it.**

`OsmNodesMap.cleanupPeninsulas` walks the road graph depth-first with no bound and relies on
the error to stop:

```java
try { minVisitIdInSubtree(null, n); }
catch (StackOverflowError soe) { /* upstream treats this as normal */ }
```

Road networks are long and stringy, so this DFS legitimately exceeds any stack — measured
usable depth is ~63,500 frames in V8 (Node and Chromium agree) and it still blew past that. On
WasmGC the exhaustion arrives as a JS `RangeError`, which is not representable as a Java
`Throwable`: it unwound through every Java frame, past even `catch (Throwable)` in `Router`,
and escaped into JS as `RangeError: Maximum call stack size exceeded`.

The fix is a third `sourcePatch`: bound the recursion explicitly and throw the error upstream
already expects. This restores upstream's own control flow rather than changing the algorithm,
and makes the cut-off deterministic instead of dependent on the host's stack.

**Verified not to change routing.** The reference corpus was generated before and after the
patch, and all six GPX outputs are byte-for-byte identical — pruning peninsulas only shrinks
the search space, it does not alter the optimal route. The cap applies to the JVM reference
build too (both compile from `build/brouter-src`), so parity holds by construction.

The cap is 2,000 frames — far below V8's ~63,500, chosen for headroom on JSC, whose worker
stack is expected to be smaller and has not been measured yet.

## Correction 6 — OPFS requires a secure context, so HTTPS is a Phase 1 requirement

Attempting Phase 1 on the phone over LAN HTTP failed with:

```
TypeError: undefined is not an object (evaluating 'navigator.storage.getDirectory')
```

`StorageManager` is annotated `[SecureContext]`, so on a plain-HTTP origin `navigator.storage`
is not restricted — it does not exist. **OPFS is therefore unavailable, and Phase 1 cannot run
over LAN HTTP at all.**

This corrects the note in `spike-1-results.md` that HTTPS was needed only "from Spike 2
onward" for `persist()` and offline caching. Spike 1 got away with HTTP purely because it
touched no storage. Desktop testing was unaffected because `http://localhost` is a secure
context by definition; only a LAN IP is not.

`provisionOpfs` now calls `assertOpfsAvailable()` first, which names the cause rather than
letting the `TypeError` surface.

The fix is `tools/make-certs.sh` plus `npm run spike-server-https`: a local CA and a server
certificate with the LAN IP in its SAN (iOS ignores CN entirely and requires `serverAuth`
EKU and ≤825 days validity). A local CA rather than a tunnel keeps the 137 MB segment
transfer on the LAN, which is both far faster and nobody else's traffic. `web/certs/` is
gitignored — the CA private key must never be committed.

## Debugging notes

- **`-PwasmDebug`** keeps Java names and line numbers in browser stack traces. Off by default
  (1.20 MB → 1.75 MB). This is what turned an opaque `wasm-function[668]` into
  `OsmNodesMap.minVisitIdInSubtree`; without it the failure localised nothing.
- **The service worker will serve a stale bundle** after a rebuild and silently cost you an
  hour. `registerType: 'autoUpdate'` re-registers on load, so unregister and clear caches
  before every verification run, or append a cache-busting query.

## On-device result

iPhone, home-screen PWA (`standalone: yes`), served over HTTPS from the LAN.

```
OPFS: 8 files, 137,661,961 bytes
vfs trekking.brf: ok:17852:-1390034577:23202a2a2a205468   (byte-exact)
vfs lookups.dat:  ok:31604:-342624937:2d2d2d6c6f6f6b75    (byte-exact)
hardware threads: 4
```

| Route | JVM | Device | Ratio | Byte-identical |
|---|---|---|---|---|
| `urban-short` | 172.5 ms | 360 ms | 2.09x | yes |
| `urban-medium` | 259.4 ms | 467 ms | 1.80x | yes |
| `fastbike-medium` | 223.5 ms | 543 ms | 2.43x | yes |
| `shortest-medium` | 125.8 ms | 344 ms | 2.73x | yes |
| `gravel-medium` | 154.1 ms | 421 ms | 2.73x | yes |
| `london-brighton` | 1,696.5 ms | **4,544 ms** | 2.68x | yes |

**76 km in 4.5 s on device.** Extrapolating the documented quadratic cost, 150 km is roughly
4x the work, so on the order of 18 s — usable for planning, and confirming the 150 km figure
is a ceiling rather than a target. Spike 3 should measure it rather than trust this.

Two caveats on these numbers: the build carried debug symbols (`-PwasmDebug`), though on
desktop that cost under 2%; and the run was made from a home-screen PWA added via Chrome.
That does not weaken the result — iOS requires all browsers to use WebKit, the UA carries no
`CriOS` token, and `standalone: yes` means it executed in Apple's home-screen web-app runtime
on JSC. A Safari-added pass is still worth doing for completeness.

### The recursion cap, and why the probe overestimates

The device reported a **maximum Java recursion depth of 25,179** in the worker (Chromium
worker: 31,871; Chromium main thread: 63,487). But the same device *failed* at a cap of 2,000
and only passed at 200.

Both numbers are real; they measure different things. `VfsProbe.probeDepth` has a nearly empty
frame, whereas `minVisitIdInSubtree` carries several locals and a loop. Stack capacity is
bytes, not frames, so a trivial function reaches depths a real one cannot — the probe
overestimates the usable budget for this call site by at least 12x.

**Treat the probe as an upper bound, never as a budget.** The cap stays at 200, which is
measured-good on device and still produces byte-identical GPX on the JVM (verified at 2,000
and again at 200). Raising it would buy more peninsula pruning and possibly some speed, but
the safe ceiling is unknown; narrowing it would need a bisect on device with the real
function, not the probe.

## Outstanding

- **Measure peak memory** and keep it under ~300 MB; `RoutingContext.memoryclass` is set to 128.
- **VFS unit tests** against the real `.rd5`: header `divisor` 32 vs legacy 80, sub-index CRCs,
  and the `asize > ab.length` re-read path at `OsmFile.java:128-131`. Currently exercised only
  incidentally, by routes that happen to succeed.
- **Cross-tile routes** — every case sits inside `W5_N50.rd5`, so the tile-seam path is untested.
- **A Safari-added home-screen pass**, for completeness — the verified run was added via Chrome
  (same WebKit runtime, but worth closing out).
- **Re-confirm device timings on a release build** — the verified run carried `-PwasmDebug`.
