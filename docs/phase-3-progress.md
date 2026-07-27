# Phase 3 — React/MapLibre PWA

**Status: the offline basemap renders, with labels and icons, offline.** London's vector tiles
decode out of OPFS and draw, glyphs and sprites come from the service worker precache, and the
whole thing was verified with the dev server killed. The cause of the long non-render is
recorded under *The map never rendered — why* below; it was not the OPFS pipeline.

Not yet verified on a physical iPhone.

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

## The map never rendered — why

The symptom: the style loads, the background layer paints, then nothing. `sourcedata` never
fires, no tiles are requested, `load` never fires, and **no `error` event is emitted**. It was
bisected down to a case with no PMTiles in it at all:

| Test | Result |
|---|---|
| OPFS-backed PMTiles archive | TileJSON OK, no tiles, no `load` |
| **HTTP-backed** PMTiles archive, same style | identical failure |
| **Plain inline GeoJSON + circle layer**, no PMTiles at all | identical failure |

That last row was read at the time as "the preview browser cannot run MapLibre". It actually
meant something narrower and more useful: **every** source type is parsed in MapLibre's worker
pool, and the worker pool was dead.

### The cause

MapLibre GL JS 6 ships its worker as a separate ES module rather than inlining it as a blob,
and finds it at runtime with

```js
new URL(`./${t}`, import.meta.url)     // t = 'maplibre-gl-worker.mjs'
```

The filename is a variable, so no bundler can see it statically. Once Vite has bundled
maplibre into `assets/index-<hash>.js`, `import.meta.url` *is* that file and the lookup
resolves to `/assets/maplibre-gl-worker.mjs` — which Vite never emitted.

### Why it was silent, twice over

Two independent things hid it, and both are worth remembering:

1. **The dev server's SPA fallback answered the missing path with `index.html` and a `200`.**
   There was no 404 in the network tab to notice — just a script request that succeeded and
   returned HTML.
2. **MapLibre wraps `new Worker(...)` in try/catch, which only catches a synchronous throw.**
   A worker whose script fails to parse fails *asynchronously*, so nothing was caught, nothing
   was logged, and the map simply sat there.

### The fix

`src/map/maplibreWorkerEntry.ts` imports `maplibre-gl/dist/maplibre-gl-worker.mjs` so Vite
bundles it as a real chunk; `src/map/maplibreWorker.ts` hands the emitted URL to MapLibre's
`setWorkerUrl()` before any `Map` is constructed — the same ordering constraint as
`addProtocol`, for the same reason.

Two details that cost an extra iteration each:

- The default export has to be **used**, not merely imported. maplibre's `sideEffects` field
  lists only `*.css` and `src/**/*.ts`, so a bare side-effect import of the dist file is
  tree-shaken away. That builds cleanly and emits a **0-byte** worker chunk.
- `maplibre-gl/dist/*` is absent from the package's `exports` types, so the import path needs
  a `declare module` in `src/vite-env.d.ts`.

Two guards were added so this cannot recur quietly:

- `checkMapLibreWorker()` fetches the worker URL on mount and reports loudly unless the
  response is JavaScript. Checking the *content type* is the point — the status code was `200`
  in the broken case.
- `tools/report-server.mjs` now returns 404 for a missing build artefact instead of falling
  back to `index.html`. The SPA fallback is for routes; `/assets/` never contains one.

### Result

```
stages: dataloading → source loaded → load
OPFS reads 6, 621 kB
2608 features: boundaries 8, roads 565, roads-casing 567, water 31, landuse 1433, earth 4
```

Central London, the Thames, parks and street geometry, read by byte range out of OPFS with no
network involved.

## Glyphs and sprites — self-hosted and precached

A PMTiles archive holds geometry and nothing else. Glyphs (SDF font atlases, one file per
256-codepoint range) and sprites (the icon sheet) are separate HTTP requests MapLibre makes on
its own, so a style with text or icon layers is online-only unless they are shipped with the
app. The failure mode is a map that looks perfect on the desk and loses every label in airplane
mode — which reads as a styling bug rather than a missing download.

`npm run fetch-map-assets` pulls them from `protomaps/basemaps-assets` into `public/`:

- **Noto Sans Regular and Noto Sans Medium**, six Unicode ranges each — Latin, Latin
  Extended-A/B, Greek, Cyrillic, and General Punctuation (en/em dashes and curly apostrophes
  turn up in ordinary place names and are easy to forget). 1.15 MB.
- The **`light` sprite sheet at 1× and 2×**. A phone will always ask for @2x, so shipping only
  1× guarantees missing icons on exactly the target device.

The output is committed rather than generated at build time: an offline-first app should not
need a network round trip to produce a map with labels in it. `globPatterns` in
`vite.config.ts` gained `pbf` and `png` so Workbox precaches them — precache is now 34 entries,
4.9 MB.

The style gained water, road and place labels plus a POI icon layer restricted to what a
cyclist stops for (drinking water, cafés, benches, toilets, stations, ferries). The icon layer
earns its place beyond decoration: without it nothing exercises the sprite, so a sprite failure
would stay invisible.

Two things surfaced doing it:

- **`zoom` must be the input to a *top-level* `interpolate`.** Nesting it inside a `match` (to
  scale place labels by settlement kind *and* zoom) is a style validation error — and MapLibre
  reports that as an `error` event on the map, not a thrown exception, so the map simply never
  loads. Restructured as one top-level zoom interpolation with a `match` at each stop.
- **The map was capped at the archive's own max zoom.** MapLibre overzooms vector tiles by
  scaling the deepest tile it has, so `maxZoom: header.maxZoom` threw away usable detail and
  put the street-level layers permanently out of reach. Now `header.maxZoom + 5`, capped at 19.

Verified offline on desktop by killing the dev server and reloading: the app came back from the
service worker precache and rendered `place-labels 1, road-labels 13, poi-icons 15` at z15 with
no origin to fetch from.

## Outstanding

- **Confirm on a physical iPhone.** Verified so far only in a Chromium-based desktop browser.
  The panel's diagnostics — load stages, worker check, OPFS read count and bytes, protocol
  request log, rendered features by layer — are deliberately still in place for that run.
- **Map UI** — waypoints, profile picker, route rendering, GPX export.
- `window.__map` is exposed for console debugging; remove it, and thin the diagnostics, once
  the device run is done.
