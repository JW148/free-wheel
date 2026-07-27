# Phase 3 — React/MapLibre PWA

**Status: the offline basemap pipeline is built and the OPFS read path is proven, but the map
has not yet been seen to render vector tiles. The preview browser used for automated checks
cannot run MapLibre at all — see *Verification blocked* below.**

## Done

### `pmtiles extract` works exactly as the plan claimed

The plan's basemap strategy rests on pulling a region out of Protomaps' planet build by byte
range rather than downloading it. Verified:

```
pmtiles extract https://demo-bucket.protomaps.com/v4.pmtiles london.pmtiles \
  --bbox=-0.35,51.35,0.15,51.65 --maxzoom=14

Extract transferred 37 MB (overfetch 0.05) for an archive size of 35 MB
Completed in 2.6s, 57 total requests
```

**35 MB out of a 137 GB remote archive, in under three seconds.** No local planet download.

### PMTiles read out of OPFS

`web/src/map/opfsPmtiles.ts` implements the `pmtiles` library's own `Source` interface against
the engine's OPFS handle registry.

**Not** `@makina-corpus/maplibre-offline-pmtiles`, which the plan suggested vendoring. Reading
what it does, it opens its own OPFS handles — and OPFS permits one open sync access handle per
file, so it would collide with the engine exactly as two Workers did in Phase 2. Implementing
`Source` is smaller and sidesteps the conflict.

Reads cross a thread boundary by necessity: sync access handles are Worker-only on iOS, while
MapLibre's protocol handler runs on the main thread. Since that handler is async anyway, the
range read is delegated to the engine Worker and the bytes transferred back.

The read path is **proven working**: the archive header and metadata are read from OPFS
(3 range reads, 19 kB) and the protocol returns a valid TileJSON, logged resolving OK.

### A trap worth knowing about in `pmtiles`

When `Protocol` does not recognise an archive key it silently constructs a `FetchSource` and
tries to fetch the key **as a URL**. A wiring mistake therefore becomes a mysterious network
request for a file that only exists in OPFS, rather than an error. The protocol registration is
wrapped to log every request and its outcome for exactly that reason.

## Verification blocked — not by the code

The map never reaches `load` or `idle`, and no tiles are ever requested. Bisected:

| Test | Result |
|---|---|
| OPFS-backed PMTiles archive | TileJSON OK, no tiles, no `load` |
| **HTTP-backed** PMTiles archive, same style | identical failure |
| **Plain inline GeoJSON + circle layer**, no PMTiles at all | identical failure |

The third case settles it: MapLibre cannot complete style loading in the preview browser used
for automated checks, and fails silently — no `error` event, nothing logged. WebGL itself works
there (`webgl2: true`, and the style background paints: a framebuffer readback returns exactly
the configured earth colour), so the likely cause is MapLibre's Web Worker pool, which parses
both GeoJSON and vector tiles.

**Nothing here indicates a fault in the OPFS pipeline**, which is why this is recorded as
blocked rather than broken. It needs a real browser.

## Outstanding

- **Confirm the basemap renders in Safari and on the phone.** Diagnostics are built into the
  panel: load stages, OPFS read count and bytes, the protocol request log, and a count of
  rendered features by layer.
- **Glyphs and sprites.** The style deliberately has no text layers yet — labels need glyph
  PBFs, which the archive does not contain and MapLibre fetches separately. Rendering geometry
  first keeps a glyph failure distinguishable from a tile-plumbing failure.
- **Map UI** — waypoints, profile picker, route rendering, GPX export.
- `window.__map` is exposed for console debugging while this is brought up; remove once the
  basemap is settled.
