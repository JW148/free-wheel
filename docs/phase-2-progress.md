# Phase 2 — Worker harness and tile management

**Status: complete. Tiles are import-only by design — the app does not download routing data.
Import verified on a physical iPhone; cross-tile routing verified byte-identical.**

## The shape of it: import only

The app never fetches routing data. The user downloads `.rd5` segments from
[brouter.de](https://brouter.de/brouter/segments4/) themselves and imports them.

This was a deliberate simplification, chosen over building a downloader. What the app does
instead is make the manual path easy: pick a region, and it tells you exactly which tiles you
need, how large each is, when brouter.de last rebuilt it, and links straight to it.

It also happens to sidestep a problem that would otherwise have forced infrastructure on us —
see *The CORS finding* below — but the simplicity is the reason, not the workaround.

### ⚠️ The trade-off: imported tiles go stale

brouter.de rebuilds every segment **weekly** from current OpenStreetMap data. An imported file
is a snapshot and **does not update itself**. Roads that have been added, removed or changed
since the import will not be reflected in routing, and nothing in the app will fix that — only
re-importing will.

The app's job is therefore to be candid about it rather than let a rider discover a year-old
road layout while out on the road. The imported list shows each tile's age, and flags it when:

- the import is more than four weeks old (brouter.de has rebuilt it several times by then), or
- brouter.de now publishes a **different size** for that tile, which is strong evidence the
  data has changed underneath it.

## Done

### Tile geometry

`web/src/engine/tiles.ts` — pure functions, no I/O. 5°×5° grid named by **south-west corner**;
longitude runs `W180`…`E175`, latitude `S90`…`N80` (note the asymmetric top and right edges).

Verified against the real catalogue rather than invented expectations: all 1,142 tile names
round-trip through `tileName`/`parseTileName`, and the antimeridian case (`west > east`) splits
correctly instead of selecting the globe the long way round.

### Tile catalogue

`npm run build-catalogue` scrapes brouter.de's directory index into
`web/public/engine/tile-catalogue.json` — every tile with its real size and rebuild date.

It confirms the plan's reference figures exactly: **1,142 tiles, 9.91 GB, median 1.2 MB,
largest 250 MB.**

The median is a trap, and the catalogue exists to avoid it. It is dominated by ocean and empty
land; the tiles anyone actually wants are two orders of magnitude bigger. `W5_N50` — southern
Britain — is **137 MB**. A UI quoting the median would understate a real download by ~100×.

### The 5° grid has sharp edges, and the UI must show them

| Preset | Tiles | Size |
|---|---|---|
| London and the South East | 2 | 215.8 MB |
| Great Britain | 6 | 290.0 MB |
| UK and Ireland, incl. Shetland | 11 | 292.4 MB |
| UK, Ireland and the Channel | 14 | **482.1 MB** |
| France | 9 | 1.11 GB |

The jump from 292 MB to 482 MB is the argument for computing sizes rather than guessing:
**Britain's southernmost point, the Lizard, sits at 49.96 °N.** Covering it requires the N45
row, which also contains northern France and Brittany — `E0_N45` alone is 126 MB. Ten
kilometres of Cornwall costs 190 MB. Adding Shetland, by contrast, costs almost nothing.

This also explains the apparent mismatch with the plan's "UK+Ireland 8 tiles / 354 MB": that
box clips both the Lizard and Shetland (7 tiles / 291 MB at today's sizes). The plan's figure
was right for its box; it just isn't the box most people want.

### Import and delete

`importTileFile` streams a user-supplied `.rd5` into OPFS — never buffered, since these reach
250 MB and `file.arrayBuffer()` on a phone would be a needless spike. `File` survives
structured cloning, so the picker stays on the main thread while the writing happens in the
Worker, where sync access handles exist.

Two details that matter:

- **Filenames must be the originals** (`W5_N50.rd5`). The name *is* the tile's south-west
  corner — it is how the router knows which part of the world the data covers. A renamed file
  would be indexed as a region whose data it does not contain, and routes there would silently
  find nothing. Validation is case-insensitive and rejects everything else, path traversal
  included.
- **Truncation happens only once the stream is readable**, so a failed import cannot destroy a
  working tile that was already there.

`deleteTile` closes the handle *before* `removeEntry` — an open sync access handle otherwise
fails removal with `NoModificationAllowedError`, which is a real failure mode hit during
development, not a theoretical one.

### Verified round-trip

Driven through the real `<input type="file">` via a `DataTransfer`, not by calling the API
directly, so the whole path including the change handler is covered:

| Step | Result |
|---|---|
| Import 137.5 MB | `complete 137.5 MB / 137.5 MB` |
| Route against it | `19579 bytes, crc 837626376` — the JVM reference exactly |
| Staleness note | `imported today` |
| Delete | no error; only `.imported.json` left in `segments4/` |
| Route after delete | `datafile W5_N50.rd5 not found` |
| Wrong filename | rejected with the explanation of why the name matters |
| 10-byte file | rejected as too small |
| Failed import over a good tile | original intact, still routes `crc 837626376` |

Two of these matter beyond the tick:

- **Delete is complete, not cosmetic.** BRouter's own "datafile not found" afterwards proves
  the VFS registry entry went with the file, rather than leaving a stale handle reporting a
  phantom tile.
- **A failed import cannot destroy a working tile.** That was only an assertion in a comment
  until it was tested; the failure mode it guards against is silent data loss.

Installed state lives in a small `.imported.json` manifest in OPFS. OPFS could in principle
supply size and mtime via `getFile()`, but the semantics of that on a file holding an open sync
access handle (an exclusive lock) are not worth relying on.

### Comlink worker harness

`engineApi.ts` (worker) / `engineClient.ts` (main thread) replace the ad-hoc `postMessage`
protocol. One handle registry is shared between the engine's VFS and the tile store, because
**OPFS allows only one open sync access handle per file** — a second would simply fail.

## Correction to the plan — cancellation

The plan specifies "cancellation via `RoutingEngine.terminate()`". **That is not reachable from
a Worker.**

`terminate()` is *cooperative*: it sets a `volatile boolean` polled at six points in the
search, so another thread must call it while `doRun` runs. A Worker is single-threaded, and
during `doRun` it is blocked inside Wasm and will not process an incoming message — so the call
can never be delivered in time.

What is actually available:

- **`maxRunningTime`**, which BRouter checks itself, bounds a run from the inside.
- **Terminating the Worker** stops a run already in progress. `EngineClient.cancel()` does
  this and transparently re-initialises on the next call. OPFS is untouched, so the cost is
  re-opening handles, not re-importing.

A genuine cooperative cancel would need a `SharedArrayBuffer` flag polled by patched BRouter
code, which in turn needs COOP/COEP headers. Not worth it yet.

## The CORS finding

Worth recording even though import-only makes it moot: **brouter.de sends no
`Access-Control-Allow-Origin` header.** Verified in a real browser — `fetch` fails outright,
and `mode: 'no-cors'` yields an opaque response whose body cannot be read. `OPTIONS` returns
405, so there is no preflight either.

A browser therefore *cannot* download tiles from brouter.de, whatever the app's design. Any
download feature would have required either a mirror we host, or a proxy — infrastructure the
plan's "no backend" premise does not have. Import-only avoids the question entirely.

Research done at the time, in case it is ever revisited:

- **There is no alternative host.** BRouter's entire source and docs reference one server. The
  obvious community candidates (`brouter.m11n.de`, `bikerouter.de`, `brouter.damsy.net`) all
  404 on `segments4/` — they are BRouter *web frontends*, not mirrors.
- **Building tiles ourselves is possible** — `brouter-map-creator` consumes Geofabrik extracts
  — but elevation needs SRTM data, and BRouter's own docs record the CGIAR link as dead as of
  2026. Tiles build fine without it, but a cycling planner without climb costs is materially
  worse.
- Range requests, `ETag` and `Accept-Ranges` all work on brouter.de. Only the CORS header is
  missing, and it is one line of nginx config on their side.

### Removed: the resumable downloader

An earlier iteration had a working `Range` + `If-Range` resumable downloader, verified against
a reconstructed partial (resumed at 52.1 MB rather than restarting, and the resulting file
routed byte-identically to the JVM reference). It was deleted when the design settled on
import-only. Recorded here so the capability is known to have worked, should the decision ever
be revisited; the git history has the implementation.

The dev server's `/segments4/` route and its `Range`/`ETag` support are kept, but **the app
does not use them** — they exist so a fixture tile can be pulled onto a test device without
re-fetching 137 MB from brouter.de every time.

## Cross-tile routing

Every earlier case sat inside `W5_N50`, so the seam-handling path in `OsmFile`/`PhysicalFile`
had never actually executed. The Greenwich meridian *is* the `W5_N50` | `E0_N50` boundary,
which makes London ideal for exercising it.

| Route | Tiles | JVM | Wasm | GPX bytes | CRC-32 |
|---|---|---|---|---|---|
| `cross-tile-short` (London Bridge → Dartford) | W5_N50 **+** E0_N50 | 763 ms | 1,141 ms | 96,527 | 73139221 ✅ |
| `cross-tile-long` (London → Canterbury) | W5_N50 **+** E0_N50 | 2,667 ms | 3,523 ms | 289,158 | 991510170 ✅ |
| `east-only` (Dartford → Canterbury) | E0_N50 | 618 ms | 792 ms | 186,252 | -261819656 ✅ |

**9/9 byte-identical.** `east-only` is deliberately included so the second tile is proven to
stand alone rather than being incidentally covered by the first. The six original CRCs are
unchanged, so adding a tile to the directory does not perturb existing routes.

`JvmRouteMain` now records which tiles each case needs, so a missing-tile failure reports
"import these first" instead of looking like a parity failure.

## Two bugs this uncovered

**Two Workers fought over OPFS.** `TilesPanel` and `RoutePanel` each constructed an
`EngineClient`, so each spawned a Worker that opened its own sync access handles for the same
files:

```
Access Handles cannot be created if there is another open Access Handle
or Writable stream associated with the same file
```

The "one open handle per file" rule was enforced *within* a Worker but not across them. The
engine is a process-wide resource, like the virtual filesystem it installs, so it is now a
singleton — `sharedEngine()`. This only surfaced once two features coexisted; it would have
hit any real UI.

**The Phase 1 harness was still downloading tiles.** `routeWorker.ts` retained `fetch`-based
provisioning, contradicting the import-only decision outright. Deleted, with the parity check
moved onto `EngineClient` — which also removed a duplicate copy of the engine-loading code.
The only `segments4` reference left in `src/` is the plain `<a href>` to brouter.de.

## Outstanding

- **Cross-tile on device.** Verified on desktop; the phone has only `W5_N50` imported, so
  re-running there needs `E0_N50` (78 MB) as well.
- **OPFS write throughput on device was never captured as a number.** Import was confirmed
  working on an iPhone — including backgrounding the app mid-import, deleting and re-importing
  — but no timing was recorded, so the cost of importing 137 MB on a phone remains unmeasured.
- **The staleness warning depends on a fresh catalogue.** `tile-catalogue.json` is a build-time
  snapshot; if `npm run build-catalogue` goes unrun for months, the warnings themselves go
  stale.
