# Regions: in-app data download, and a Setup screen for strangers

Written 2026-09-11. Design for Phase 6 (data plane and the region picker) and Phase 7
(Setup polish).

## Why

The app is close to shareable. What stops it is the first five minutes: a new rider is told
to fetch a `.pmtiles` archive they have to build with a CLI, and an `.rd5` file named after a
5 degree grid square, then import both through the iOS Files app. Anyone who does not already
know how the app works has no reason to guess why.

The fix is to host the data ourselves and let the app download it. The cost of doing that is
staleness, which is the thing this design has to answer for rather than hide.

## What changes about the repo's rules

`CLAUDE.md` and the header comment in `web/src/engine/tileStore.ts` currently say the app
never downloads routing data and that no downloader may be added. That rule stands for
brouter.de and is now stated more precisely:

- The app downloads from our mirror only.
- The app never fetches from brouter.de, and never routes against it.
- brouter.de sees eight conditional requests per week from one cron job, instead of one full
  download per new user.

Both files get updated as part of Phase 6. Manual import survives as an escape hatch, so
nothing that works today stops working.

## Audience and scope

Riders anywhere in Britain. That rules out bundling data with the app: Britain needs six to
eight `.rd5` segments (`W5_N50` alone is 137 MB), and a z14 basemap for the whole island runs
to gigabytes.

Measured on 2026-09-10 against `https://build.protomaps.com/20260906.pmtiles`:

| Extract | Area | Archive at z14 | Per square degree |
|---|---|---|---|
| Britain, z0 to z10 only | whole island | 61 MB | n/a |
| Central Belt, `-5.0,55.4 to -2.4,56.3` | 2.34 sq deg | 86 MB | 37 MB |
| London, `-0.5,51.3 to 0.3,51.7` | 0.32 sq deg | 54 MB | 168 MB |

Dense England costs 4.5 times per square degree what the Central Belt does, so regions cannot
be a uniform geographic grid. They are cut to a byte budget instead.

## The data plane

### Bucket layout

One bucket on the existing Hetzner S3 (managed through Coolify). One fixed URL.

```
manifest.json                             mutable, Cache-Control: max-age=300
basemap/uk-z10-<hash8>.pmtiles            61 MB, streamed by the picker, never downloaded
regions/central-scotland-<hash8>.pmtiles  the region basemaps
segments4/W5_N55-<hash8>.rd5              the mirrored BRouter segments
```

Every object except the manifest carries a content hash in its name and
`Cache-Control: public, max-age=31536000, immutable`. That is the whole freshness mechanism:
objects never change, so "is my copy current" is a string comparison against the hash the
phone recorded at download time. No date arithmetic and no guessing.

### CORS

The bucket must allow `GET` and `HEAD` from the app origin with the `Range` request header,
and expose `Content-Range`, `Content-Length`, `Accept-Ranges` and `ETag`. Ranged reads are
what make the streamed picker and resumable downloads work.

### The manifest

```jsonc
{
  "version": 1,
  "generated": "2026-09-11T04:00:00Z",
  "picker": { "url": "basemap/uk-z10-8f3a1c2d.pmtiles", "bytes": 60959264 },
  "segments": {
    "W5_N55": {
      "url": "segments4/W5_N55-3b7f9a01.rd5",
      "bytes": 27262976,
      "hash": "3b7f9a01",
      "changed": "2026-08-24T03:10:00Z"   // when the bytes last differed, not when rebuilt
    }
  },
  "regions": [
    {
      "id": "central-scotland",
      "name": "Central Scotland",
      "bbox": [-5.0, 55.4, -2.4, 56.3],
      "basemap": { "url": "regions/central-scotland-1c9d4e77.pmtiles", "bytes": 86384407,
                   "hash": "1c9d4e77", "built": "2026-09-08" },
      "segments": ["W5_N55"]
    }
  ]
}
```

A region names its segments in the manifest rather than deriving them on the phone. The cron
job computes them with the same 5 degree geometry `web/src/engine/tiles.ts` already
implements, so the two agree, and the app can still derive them as a check.

### The weekly sync job

Runs on the VPS. Roughly eight requests to brouter.de per week.

1. Conditional `GET` per Britain segment with `If-Modified-Since`. A `304` ends it.
2. On `200`, hash the body. If the hash matches what is already mirrored, discard it.
   brouter.de rebuilds weekly whether or not OpenStreetMap changed anything inside the tile,
   and this step is what keeps the promise that a rider is only told to update when the bytes
   actually differ.
3. On a real change, upload under the new hashed name, rewrite the manifest, and keep the
   previous object for one week so a rider who is mid-download is not orphaned.
4. Write `manifest.json` last, and atomically. A manifest that names an object which is not
   uploaded yet is the one failure that breaks every client at once.

### Basemap rebuilds are monthly, not weekly

A Protomaps daily build changes the bytes of an extract almost every time, so hashing does
not damp basemap churn the way it damps segment churn. Re-cutting monthly keeps an 86 MB
re-download from being offered because a cafe moved. Basemap updates appear in Setup and are
never nagged about. Routing data is the half that can put a rider on a road that no longer
exists.

### Integrity is a length check, not a hash

`SubtleCrypto` has no streaming digest, so verifying a 137 MB download on a phone means
holding it in memory. The realistic failure is truncation, and `Content-Length` catches that
for free. A download whose final size does not match the manifest is discarded and retried.

### Region list

Regions are cut to a byte budget rather than drawn to look tidy. Candidate boxes are
extracted with `pmtiles extract`, and anything over roughly 200 MB of basemap is split. That
gives ten to fourteen regions, where the Highlands are geographically large and the South East
is several small ones. The list is produced during implementation and committed as the cron
job's input, so a region's bounds are reviewable in git.

## The app

### Modules

- `web/src/data/manifest.ts` fetches, validates and caches the manifest in OPFS, and holds
  the comparison functions that decide what is outdated. Pure enough to test without a
  network.
- `web/src/data/regions.ts` computes what a region costs: its basemap plus the segments it
  needs, minus whatever is already installed and shared with another region.
- `web/src/engine/downloads.ts` runs in the engine Worker. It streams a `fetch` into OPFS with
  progress, and resumes from the file's current size with a `Range` header. It reuses the
  write path in `tileStore.importTileFile`; the only new part is a `Response` body where a
  `File` stream used to be.
- `web/src/engine/regionStore.ts` records what is installed in `/regions.json`: region id, the
  hashed URLs it came from, and when. It sits beside the existing
  `/segments4/.imported.json` rather than replacing it, so manually imported tiles still
  appear.

### The picker costs almost no new code

`web/src/map/opfsPmtiles.ts` wraps the `pmtiles` library's own `Protocol`, which falls back to
a network `FetchSource` for any key it does not recognise. The existing comments treat that
fallback as a hazard. Here it is the feature: `pmtiles://https://<bucket>/uk-z10-<hash>.pmtiles`
streams the picker's map of Britain over ranged reads with no new source type. `useMapLibre`
gains a `showRemote(url)` beside its existing `show(name)`.

Streaming means the 61 MB picker archive is never downloaded. A rider looking at Britain at
z6 pulls a few hundred kilobytes.

### Screens

`FirstRun.tsx` becomes the region picker. A streamed map of Britain, region outlines drawn
over it, tap the one you ride in, then a sheet that says "Central Scotland, map 86 MB plus
road data 26 MB" and downloads both under one progress bar. The words `.rd5` and `.pmtiles`
do not appear.

`SetupView.tsx` restructures into four sections:

- **Regions.** What is installed, how big, whether new road data exists, add and remove.
- **Preferences.** Units, which routing profiles appear in the compare sheet, and whether to
  keep the screen awake. There is nowhere for these today; theme and path mode stay on the
  ride rail where they are used.
- **About.** How the app works, where the data comes from, credits for BRouter, OpenStreetMap
  and Protomaps, and the build stamp.
- **Advanced.** Manual `.pmtiles` and `.rd5` import, and reset storage.

Diagnostics survives unchanged, reachable by tapping the build stamp in About. It is the
project's regression net and a net you have to rebuild to use does not get used, but a
stranger should not open Setup and find a spike harness.

`TilesPanel`'s region estimator and the `npm run build-catalogue` script that scrapes
brouter.de are deleted. The manifest replaces both. `BasemapPanel` moves into Advanced.

### Two things the Worker forces

A download must re-run `installedTiles()` when it finishes. That call is what opens the `.rd5`
handles and registers `/segments4` in the VFS directory registry, and without it BRouter
reports that the segment directory does not exist while the file sits in OPFS. This already
bit the project once when `TilesPanel` stopped mounting on every load, and it only shows up on
a cold start.

Routing blocks the Worker. A download running while a route is computed will stall until the
route returns. Downloads happen from Setup rather than mid-ride, so this is a queueing
question rather than a correctness one, but the UI should not pretend a stalled progress bar
is a failure.

### Errors, and one thing we cannot do

- Offline with a cached manifest: regions list works, update state reads as unknown rather
  than wrong.
- Offline having never fetched a manifest: say so, and offer manual import.
- Quota exceeded: surface it and suggest removing a region. Per the repo rule we never
  pre-size against `navigator.storage.estimate()`, whose value is deliberately fuzzed.
- Safari does not implement NetworkInformation, so there is no honest way to warn that a rider
  is on mobile data. The size goes in front of the button in plain megabytes and the rider
  decides.

### Visual work in Setup

`.setup-header` hardcodes `rgb(6 20 27 / 92%)`, so the light theme currently gets a dark bar.
That moves to a token. Tables become list rows with tap targets of at least 44px. Sections
adopt the ride chrome's `--panel*` tokens so Setup stops looking like a different app. The
existing `100dvh` and standalone `100lvh` rules in `ride.css` already cover the safe area and
must not be reverted.

## Testing

Unit tests, against a fixture manifest:

- manifest validation, including a manifest naming an object that does not exist
- the freshness comparison, covering a rebuild with identical bytes (no update offered) and a
  real content change (update offered)
- region to segment mapping, checked against `tilesForBbox`
- resume offset arithmetic, including a resume at exactly the file length
- a region's cost when one of its segments is already installed for a neighbouring region

The GPX parity corpus and `style.test.ts` are untouched. Nothing here goes near routing or the
palette.

Device acceptance is unchanged and now starts from a colder start: on a real iPhone added to
the Home Screen, tap one region, wait for the download, enable airplane mode, cold launch,
plan a route, follow it.

## Phasing

**Phase 6.** Bucket, sync job, manifest, downloads in the Worker, the region picker, and the
rule changes in `CLAUDE.md` and `tileStore.ts`. Worth riding before Phase 7 starts.

**Phase 7.** The Setup restructure: Regions, Preferences, About, Advanced, the Diagnostics
gesture, and the visual work.
