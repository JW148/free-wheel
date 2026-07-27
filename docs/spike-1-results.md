# Spike 1 — TeaVM toolchain proof

**Status: PASSED. All success criteria met, including on a physical iPhone.**

Goal, from the plan: prove Java → WasmGC → Web Worker → home-screen PWA using real BRouter
compute but no file I/O. OPFS, `.rd5`, `RoutingEngine` and the VFS are deliberately excluded —
those are Phase 1.

## What was built

| Path | What |
|---|---|
| `engine/` | Gradle project, TeaVM 0.15.0, emits WasmGC + JS from one source |
| `engine/src/main/java/btools/wasm/SpikeMain.java` | The `@JSExport` surface |
| `engine/src/main/java/btools/wasm/JvmParityMain.java` | Generates the JVM reference corpus |
| `web/` | Vite + React + TS PWA that runs the corpus in a Worker |
| `web/src/spike/engine.worker.ts` | Loads a backend, replays the corpus, times the kernels |
| `web/tools/report-server.mjs` | LAN server + `POST /spike-report`, so devices report their own results |

BRouter's sources are compiled **in place from the read-only symlink** via additive sourceSet
`srcDirs`. A Gradle composite build (`includeBuild '../brouter-link'`) was rejected because it
creates `.gradle/` and `build/` directories inside the linked upstream checkout.

## Results

### Success criteria — all met

- [x] `.wasm` artifact builds, and its size is recorded — **but see the caveat below**
- [x] Loads and runs in a Worker in desktop Safari (26.5.2) **and** in a home-screen PWA on a real iPhone
- [x] Exported results are **bit-identical** to the JVM — on every runtime tested
- [x] Wasm-vs-JVM slowdown factor measured, on desktop and on device
- [x] JS-backend fallback also loads and returns identical results

### Parity — bit-identical everywhere, including under JSC

Doubles are compared as the hex of their IEEE-754 bit pattern, not their decimal rendering, so
this is exact rather than approximate.

| Case | JVM 21 | Chromium/V8 | Safari/JSC | iPhone/JSC |
|---|---|---|---|---|
| `distance/hyde-park-corner` (~786 m) | `40888e141c1bc8d4` | ✅ | ✅ | ✅ |
| `distance/london-brighton` (~76.2 km) | `40f29a70c9fa3447` | ✅ | ✅ | ✅ |
| `distance/london-paris` (~344.0 km) | `4114ff872466efb6` | ✅ | ✅ | ✅ |
| `heap/1000` | `353718958` | ✅ | ✅ | ✅ |
| `heap/200000` | `-1074197140` | ✅ | ✅ | ✅ |
| `crc/1000` | `-1041974739` | ✅ | ✅ | ✅ |

Both backends pass every case on every runtime. Two things make this more than a formality:

- **`SortedHeap` on 200 000 elements** folds the *pop order* into its checksum, so it only matches
  if the Dijkstra open set orders identically. It does.
- **JSC's doubles agree with HotSpot's bit-for-bit.** That is the load-bearing finding for the
  Verification plan: the byte-identical-GPX regression net will hold on-device, not just on the
  JVM. Had `CheapRuler` diverged in the last mantissa bit, that whole strategy would have needed
  a tolerance-based rewrite.

### Performance

Best-of-5 after a warmup, all measured against the same JDK 21 baseline on this Mac.

| Runtime | `heapBenchmark(200000)` | `crcBenchmark(5000)` |
|---|---|---|
| JDK 21 (baseline) | 21.5 ms | 42.1 ms |
| Chromium / V8 — WasmGC | 22.0 ms (**1.02×**) | 42.0 ms (**1.00×**) |
| **desktop Safari / JSC — WasmGC** | **22 ms (1.02×)** | **42 ms (1.00×)** |
| desktop Safari / JSC — JS backend | 26 ms (1.21×) | 33 ms (0.78×) |
| **iPhone / JSC — WasmGC** | **43 ms (2.00×)** | **64 ms (1.52×)** |
| iPhone / JSC — JS backend | 52 ms (2.42×) | 48 ms (1.14×) |

Readings that matter:

1. **JSC's WasmGC is at parity with the JVM on desktop** — 1.02× and 1.00×. The concern that
   Safari's younger WasmGC implementation would lag V8 did not materialise on these kernels.
2. **The iPhone is only ~2× the desktop JVM.** For a phone against a warmed-up server VM on an
   M-series Mac, that is a good result and materially better than the plan's tone implied.
3. **WasmGC beats the JS fallback on the kernel that matters** (43 ms vs 52 ms on the heap), while
   losing on the tight integer loop. So WasmGC is correctly the primary target, and the fallback is
   genuinely viable rather than merely present — about 20% slower on the hot data structure.
4. **Module load is negligible**: 37 ms on-device for WasmGC, 13 ms for JS.

Caveats to carry into Spike 3:

- **Safari clamps `performance.now()` to 1 ms.** Every on-device figure above is an integer for
  that reason. The benchmarks need to run ~10× longer before their timings carry real resolution.
- **These kernels are not a route search.** No `.rd5` decoding, no sustained allocation pressure,
  a working set that fits in cache. A ~2× factor here does not license extrapolating to a 2×
  factor on a 100 km route.
- The phone reports 4 `hardwareConcurrency`; everything here is single-threaded regardless.

### Artifact size

| File | Raw | gzip |
|---|---|---|
| `brouter-wasm.wasm` | 23.8 KB | 10.8 KB |
| `brouter-wasm.wasm-runtime.js` | 16.4 KB | 5.8 KB |
| `brouter-wasm.js` (JS backend) | 18.7 KB | 7.8 KB |

⚠️ **This neither validates nor refutes the plan's 1–2 MB estimate.** Spike 1 depends on
`:brouter-util` only and TeaVM's dead-code elimination keeps just the three classes actually
reached. The estimate is about `:brouter-core` and its transitive modules, which Phase 1 adds.
The useful finding here is the *floor*: the TeaVM runtime overhead is ~16 KB, not megabytes.

## Findings that correct the plan

1. **`options.release = 11` breaks TeaVM dependency resolution.** Gradle derives a "JVM 11
   consumer" attribute from `release`, then refuses `org.teavm:teavm-classlib` because it targets
   17+. The bytecode target and what can be read off the classpath are separate concerns. Fixed in
   `engine/build.gradle` by overriding `TargetJvmVersion` on the resolvable configurations to 21
   while still emitting Java 11 bytecode.

2. **The runtime is not an ES module by default.** The plan's snippet
   `import { load } from "./brouter.wasm-runtime.js"` does not work against 0.15.0's default
   output, which is an IIFE installing `globalThis.TeaVM.wasmGC`. Setting
   `wasmGC { modularRuntime = true }` produces the module the plan assumed. Likewise
   `js { moduleType = ES2015 }`, since the JS backend otherwise emits UMD.

3. **`teavm { wasmGC { outputDir } }` appends a per-target subdirectory.** Point it at the parent
   or you get `wasm-gc/wasm-gc/`.

4. **A Worker cannot derive the app's base URL.** After bundling, `self.location` is
   `/assets/engine.worker-<hash>.js`, so engine URLs resolved relative to the worker land in the
   wrong directory. The base URI is passed in from the main thread instead.

5. **Homebrew's `openjdk@21` is keg-only.** It is not symlinked into `/opt/homebrew/bin`, so a
   bare `java` resolves to the macOS stub and fails. `JAVA_HOME` must point at
   `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`, and
   `engine/gradle.properties` registers that path for toolchain detection.

   The corpus was generated first under Temurin 21.0.11 and later under Homebrew 21.0.12; **every
   expected value was byte-for-byte identical**, so the reference is not sensitive to the JDK
   build it came from.

6. **`navigator.clipboard` is secure-context-only.** Over plain LAN HTTP it is `undefined`, not
   merely permission-denied, so any "copy results" affordance needs the `execCommand` fallback.

Nothing in the plan's core thesis was contradicted. The TeaVM route works.

## Verdict and what it means for the plan

**Spike 1 passes cleanly. Proceed to Phase 1** (the real engine: `:brouter-core`, the
`OpfsVirtualFileSystem`, `RoutingEngine`).

Adjustments the results justify:

- **Keep the JS fallback, but treat WasmGC as unambiguously the primary.** The maintainer's stance
  on Safari (#1151) was the reason for the fallback; JSC turning out to be at parity with the JVM
  on desktop and ~2× on device means the risk it insures against is smaller than feared. Still
  cheap insurance — retain it.
- **The perf picture is better than the plan assumed.** "Wasm will not beat native JVM" held only
  in the sense that it did not *beat* it; it matched it. Spike 3 remains the real test, but the
  150 km ceiling inherited from 2011-era Android now looks pessimistic rather than optimistic.
- **The GPX byte-parity regression net is safe to build on**, because JSC's floating point agrees
  with HotSpot's exactly.
- **Artifact size is still unmeasured** in any meaningful sense. Phase 1 is the first point at
  which the 1–2 MB estimate can be tested.

## On-device run — how it was captured

Served over the LAN with `npm run spike-server`, added to the Home Screen, launched from the icon
(`display-mode: standalone` confirmed `yes`), then **Send to laptop** POSTed the results back.

Two environment things had to be cleared, both recorded here because they will recur every time a
device test is run:

- **The macOS application firewall had `node` explicitly set to "Block incoming connections"** —
  not merely un-prompted. Fixed via System Settings → Network → Firewall → Options. Note `jwig` is
  not in the `admin` group, so `sudo socketfilterfw` is not an option from a normal session.
- **Backgrounded Safari throttles hard enough to stall the run.** Capturing desktop Safari needed
  the window foregrounded; the run completed in ~2 s once it was. Worth remembering for Spike 3 —
  a backgrounded tab will produce garbage timings rather than an obvious failure.

Plain HTTP was sufficient: `secure context: no` costs only the service worker, which no Spike 1
criterion touches. **HTTPS is required from Spike 2 onward** (`navigator.storage.persist()`,
offline caching), and no tunnel tool is installed yet — see the README.

## ⚠️ Unresolved: which iOS version is this?

The phone's User-Agent is internally inconsistent:

```
Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15
  (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1
```

`Version/26.5.2` matches the desktop Safari on this Mac, while the OS token says `18_7`. Those
imply different things and I have not established which is authoritative — Apple has frozen UA OS
tokens before, and iOS 18.7 also genuinely exists as a security-update branch alongside iOS 26.

**Confirm from Settings → General → About before Spike 2.** It matters twice over: the plan
baselines **iOS 18.4+** for Screen Wake Lock in home-screen PWAs, and `persist()` behaviour is
exactly the version-sensitive unknown Spike 2 exists to measure. Recording "iOS 26.5" off this UA
would be a guess.

The iPhone run should record: whether both backends load, whether parity holds under JSC, the
WasmGC-vs-JVM ratio on-device, and whether `display-mode: standalone` reports correctly from the
Home Screen icon.
