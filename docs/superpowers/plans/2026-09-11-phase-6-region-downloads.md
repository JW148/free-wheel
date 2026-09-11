# Phase 6: region downloads implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new rider opens free-wheel, sees a streamed map of Britain, taps the region they ride in, and gets both the basemap and the routing data downloaded in one action, with the app told later only when the road data actually changed.

**Architecture:** A mirror on the existing Hetzner S3 bucket holds content-addressed copies of BRouter's segments and pre-cut region basemaps, described by a single `manifest.json`. A cron job on the VPS refreshes it and only republishes when bytes differ. In the app, a new `src/data/` layer parses the manifest and decides what to download, a new `downloads.ts` in the engine Worker streams bytes into OPFS with resume support, and the first-run screen becomes a region picker that streams its backdrop from the bucket instead of gating on a download.

**Tech Stack:** TypeScript, React, Vite, MapLibre GL JS 6, pmtiles, Comlink, OPFS, vitest. Mirror tooling is plain Node ESM plus `@aws-sdk/client-s3` and the existing `~/bin/pmtiles` CLI.

**Spec:** `docs/superpowers/specs/2026-09-11-region-download-onboarding-design.md`

## Global constraints

- **Never modify anything under `brouter-link/`.** It is a symlink to a separate read-only checkout.
- **Only one open OPFS sync access handle per file.** Always go through `openHandle()` in `web/src/engine/opfsVfs.ts`. Never call `createSyncAccessHandle()` anywhere else.
- **OPFS sync access handles are Worker-only on iOS.** All OPFS writes happen in the engine Worker, reached over Comlink. Never from the main thread.
- **`engineApi.init()` must keep calling `installedTiles()`**, and any completed download must call it again. That call is what registers `/segments4` in the VFS's in-memory directory registry; without it BRouter reports `segment directory /segments4 does not exist` while the file sits in OPFS, and only on a cold start.
- **No backend and no environment variables.** `vercel.json` stays a static build. The bucket's public base URL is a committed constant.
- **Never size anything off `navigator.storage.estimate()`.** The value is fuzzed.
- **The app must never fetch from brouter.de.** Only the mirror job talks to it.
- **The GPX parity corpus must stay green.** Nothing in this phase touches routing; if `npx vitest run` reports a parity failure, stop.
- **Tests live beside their source** as `*.test.ts`, run with `npx vitest run` from `web/`.
- **Target iOS 18.4+ Safari.** No `NetworkInformation`, no `SubtleCrypto` streaming digest.

---

## File structure

**Created in `web/src/data/` (main thread, pure, no OPFS):**
- `origin.ts` the bucket's public base URL and the manifest URL.
- `manifest.ts` manifest types, `parseManifest()`, and `regionState()`.
- `manifest.test.ts`
- `regions.ts` `downloadPlan()`, which decides what bytes a region actually costs.
- `regions.test.ts`

**Created in `web/src/engine/` (Worker side):**
- `downloads.ts` `resumeDecision()`, the `ByteSink` interface, and `downloadInto()`.
- `downloads.test.ts` uses a fake sink and a fake `fetch`, so no OPFS is needed.
- `regionStore.ts` `InstalledRegion` records, `recordAfterDownload()`, `recordsAfterRemoval()`.
- `regionStore.test.ts`

**Created in `web/src/setup/`:**
- `RegionPicker.tsx` replaces `FirstRun.tsx` as the first-run screen.
- `regionLayers.ts` region outlines on the map, following the `ride/routeLayers.ts` pattern.
- `regionLayers.test.ts`

**Created in `web/tools/mirror/` (Node ESM, runs on the VPS):**
- `regions.json` the committed region definitions.
- `lib/geometry.mjs` 5 degree segment names for a bbox.
- `lib/geometry.test.mjs` cross-checked against `src/engine/tiles.ts`.
- `lib/manifest.mjs` `buildManifest()` and the upload ordering rule.
- `lib/manifest.test.mjs`
- `lib/decide.mjs` `decideSegmentAction()`, the hash comparison.
- `lib/decide.test.mjs`
- `sync-segments.mjs` weekly job.
- `cut-basemaps.mjs` monthly job.
- `s3.mjs` a thin wrapper over `@aws-sdk/client-s3`.

**Modified:**
- `web/src/engine/engineApi.ts` new `downloadRegion`, `installedRegions`, `removeRegion`.
- `web/src/engine/engineClient.ts` type surface follows automatically.
- `web/src/map/opfsPmtiles.ts` `mountRemoteBasemap()`.
- `web/src/ride/useMapLibre.ts` `showRemote()`.
- `web/src/map/style.ts` no change needed. Its `archive` argument is only interpolated into the source URL, so a full https URL already works. Task 10 adds a test that pins this.
- `web/src/App.tsx` renders `RegionPicker` instead of `FirstRun`.
- `web/package.json` `@aws-sdk/client-s3` devDependency, `mirror:segments` and `mirror:basemaps` scripts.
- `CLAUDE.md`, `HANDOFF.md`, `web/src/engine/tileStore.ts` header the rule change.

**Deleted:** nothing. `TilesPanel`, `BasemapPanel` and `npm run build-catalogue` keep working through Phase 6 and are removed in Phase 7 with the Setup restructure.

---

## Task 1: segment geometry for the mirror

The mirror needs to know which `.rd5` segments a region's bbox touches. `web/src/engine/tiles.ts` already implements that geometry for the app, and the two must not drift.

**Files:**
- Create: `web/tools/mirror/lib/geometry.mjs`
- Create: `web/tools/mirror/lib/geometry.test.mjs`

**Interfaces:**
- Consumes: `tilesForBbox(bbox: Bbox): string[]` from `web/src/engine/tiles.ts`, where `Bbox` is `{ west, south, east, north }`.
- Produces: `segmentsForBbox(bbox: [number, number, number, number]): string[]`, bbox as `[west, south, east, north]`, returned sorted.

- [ ] **Step 1: Write the failing test**

```javascript
// web/tools/mirror/lib/geometry.test.mjs
import { describe, expect, it } from 'vitest'
import { segmentsForBbox } from './geometry.mjs'
import { tilesForBbox } from '../../../src/engine/tiles'

describe('segmentsForBbox', () => {
  it('names the single segment a Central Belt box sits inside', () => {
    expect(segmentsForBbox([-5.0, 55.4, -2.4, 56.3])).toEqual(['W5_N55'])
  })

  it('names both segments when a box straddles the 55th parallel', () => {
    expect(segmentsForBbox([-3.5, 54.5, -2.5, 55.5])).toEqual(['W5_N50', 'W5_N55'])
  })

  it('agrees with the app geometry it must not drift from', () => {
    const boxes = [
      [-5.0, 55.4, -2.4, 56.3],
      [-0.5, 51.3, 0.3, 51.7],
      [-8.7, 49.8, 2.0, 61.0],
      [-3.5, 54.5, -2.5, 55.5],
    ]
    for (const [west, south, east, north] of boxes) {
      expect(segmentsForBbox([west, south, east, north]))
        .toEqual([...tilesForBbox({ west, south, east, north })].sort())
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tools/mirror/lib/geometry.test.mjs`
Expected: FAIL, cannot resolve `./geometry.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/tools/mirror/lib/geometry.mjs
/**
 * BRouter segment names for a bounding box.
 *
 * Deliberately a second implementation of the geometry in `src/engine/tiles.ts` rather than
 * an import: this file runs under plain Node on the VPS with no TypeScript toolchain. The
 * test asserts the two agree, which is what stops them drifting.
 */
const TILE_DEGREES = 5

const originOf = (degrees) => Math.floor(degrees / TILE_DEGREES) * TILE_DEGREES

const name = (lon, lat) => {
  const ew = lon < 0 ? `W${-lon}` : `E${lon}`
  const ns = lat < 0 ? `S${-lat}` : `N${lat}`
  return `${ew}_${ns}`
}

export function segmentsForBbox([west, south, east, north]) {
  const names = new Set()
  for (let lon = originOf(west); lon < east; lon += TILE_DEGREES) {
    for (let lat = originOf(south); lat < north; lat += TILE_DEGREES) {
      names.add(name(lon, Math.min(lat, 80)))
    }
  }
  return [...names].sort()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tools/mirror/lib/geometry.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/tools/mirror/lib/geometry.mjs web/tools/mirror/lib/geometry.test.mjs
git commit -m "Mirror: segment geometry, cross-checked against the app's"
```

---

## Task 2: the region list

**Files:**
- Create: `web/tools/mirror/regions.json`
- Create: `web/tools/mirror/lib/regions.test.mjs`

**Interfaces:**
- Produces: `regions.json` as an array of `{ id, name, bbox: [west, south, east, north] }`, consumed by every later mirror task and validated here.

Sizes come from the measurements in the spec: the Central Belt is 37 MB per square degree at z14, London is 168 MB. The budget is roughly 200 MB of basemap per region, which is why the South East is cut small and the Highlands are not.

- [ ] **Step 1: Write the failing test**

```javascript
// web/tools/mirror/lib/regions.test.mjs
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { segmentsForBbox } from './geometry.mjs'

const regions = JSON.parse(readFileSync(new URL('../regions.json', import.meta.url), 'utf8'))

describe('regions.json', () => {
  it('gives every region a unique id and a name', () => {
    const ids = regions.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const region of regions) {
      expect(region.id).toMatch(/^[a-z0-9-]+$/)
      expect(region.name.length).toBeGreaterThan(2)
    }
  })

  it('orders every bbox west, south, east, north', () => {
    for (const { id, bbox } of regions) {
      const [west, south, east, north] = bbox
      expect(west, id).toBeLessThan(east)
      expect(south, id).toBeLessThan(north)
    }
  })

  it('covers Edinburgh, Bristol and central London', () => {
    const covers = (lon, lat) =>
      regions.some(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)
    expect(covers(-3.19, 55.95), 'Edinburgh').toBe(true)
    expect(covers(-2.59, 51.45), 'Bristol').toBe(true)
    expect(covers(-0.12, 51.51), 'London').toBe(true)
  })

  it('needs at most two segments per region, so no download carries a spare 137 MB', () => {
    for (const region of regions) {
      expect(segmentsForBbox(region.bbox).length, region.id).toBeLessThanOrEqual(2)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tools/mirror/lib/regions.test.mjs`
Expected: FAIL, cannot read `regions.json`.

- [ ] **Step 3: Write the region list**

```json
[
  { "id": "highlands-islands", "name": "Highlands and Islands", "bbox": [-7.7, 56.3, -2.4, 58.7] },
  { "id": "central-scotland", "name": "Central Scotland", "bbox": [-5.0, 55.4, -2.4, 56.4] },
  { "id": "southern-scotland", "name": "Southern Scotland and the Borders", "bbox": [-5.3, 54.6, -1.9, 55.5] },
  { "id": "north-east-england", "name": "North East England", "bbox": [-2.7, 54.0, -0.7, 55.5] },
  { "id": "north-west-england", "name": "North West England and the Lakes", "bbox": [-3.7, 53.2, -2.0, 55.0] },
  { "id": "yorkshire", "name": "Yorkshire", "bbox": [-2.6, 53.3, -0.1, 54.6] },
  { "id": "north-wales", "name": "North Wales", "bbox": [-5.4, 52.4, -2.6, 53.5] },
  { "id": "south-wales", "name": "South Wales", "bbox": [-5.4, 51.3, -2.6, 52.5] },
  { "id": "midlands", "name": "The Midlands", "bbox": [-2.8, 52.0, -0.5, 53.4] },
  { "id": "east-anglia", "name": "East Anglia", "bbox": [-0.6, 51.9, 1.8, 53.0] },
  { "id": "south-west-england", "name": "South West England", "bbox": [-5.8, 49.9, -2.4, 51.5] },
  { "id": "wessex", "name": "Wessex and the South Coast", "bbox": [-2.6, 50.5, -0.7, 51.6] },
  { "id": "london-home-counties", "name": "London and the Home Counties", "bbox": [-1.0, 51.2, 0.6, 52.1] },
  { "id": "kent-sussex", "name": "Kent and Sussex", "bbox": [-0.9, 50.6, 1.6, 51.5] }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tools/mirror/lib/regions.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Measure the two densest regions before trusting the budget**

Run:
```bash
cd /Users/jwig/Dev/Personal/free-wheel
~/bin/pmtiles extract https://build.protomaps.com/20260906.pmtiles /tmp/london-home-counties.pmtiles \
  --bbox=-1.0,51.2,0.6,52.1 --maxzoom=14 2>&1 | tail -1
~/bin/pmtiles extract https://build.protomaps.com/20260906.pmtiles /tmp/midlands.pmtiles \
  --bbox=-2.8,52.0,-0.5,53.4 --maxzoom=14 2>&1 | tail -1
```
Expected: each reports an archive size. If either is over 250 MB, split that region in two in `regions.json`, re-run the tests, and record the measured sizes in a comment at the top of the mirror README. Do not guess: the London probe measured 168 MB per square degree, so a region that looks small can still be the largest.

- [ ] **Step 6: Commit**

```bash
git add web/tools/mirror/regions.json web/tools/mirror/lib/regions.test.mjs
git commit -m "Mirror: the region list, cut to a byte budget"
```

---

## Task 3: the publish decision

The promise the whole design rests on is that a rider is told to re-download only when the bytes actually changed. brouter.de rebuilds weekly whether or not anything inside the tile changed, so `Last-Modified` alone would nag every week.

**Files:**
- Create: `web/tools/mirror/lib/decide.mjs`
- Create: `web/tools/mirror/lib/decide.test.mjs`

**Interfaces:**
- Produces: `decideSegmentAction({ status, upstreamHash, mirrored })` returning `{ action: 'skip', reason }` or `{ action: 'publish', hash }`. `mirrored` is the current manifest entry or `undefined`.
- Produces: `hashOf(buffer): string`, the first 8 hex characters of the SHA-256.

- [ ] **Step 1: Write the failing test**

```javascript
// web/tools/mirror/lib/decide.test.mjs
import { describe, expect, it } from 'vitest'
import { decideSegmentAction, hashOf } from './decide.mjs'

describe('hashOf', () => {
  it('is eight stable hex characters', () => {
    expect(hashOf(Buffer.from('brouter'))).toMatch(/^[0-9a-f]{8}$/)
    expect(hashOf(Buffer.from('brouter'))).toBe(hashOf(Buffer.from('brouter')))
    expect(hashOf(Buffer.from('brouter'))).not.toBe(hashOf(Buffer.from('brouterr')))
  })
})

describe('decideSegmentAction', () => {
  it('publishes a segment that has never been mirrored', () => {
    expect(decideSegmentAction({ status: 200, upstreamHash: 'aaaa1111', mirrored: undefined }))
      .toEqual({ action: 'publish', hash: 'aaaa1111' })
  })

  it('skips a 304, because upstream said nothing changed', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 304, upstreamHash: null, mirrored }))
      .toEqual({ action: 'skip', reason: 'not-modified' })
  })

  it('skips a rebuild whose bytes are identical, which is the weekly case', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 200, upstreamHash: 'aaaa1111', mirrored }))
      .toEqual({ action: 'skip', reason: 'identical-bytes' })
  })

  it('publishes when the bytes really differ', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 200, upstreamHash: 'bbbb2222', mirrored }))
      .toEqual({ action: 'publish', hash: 'bbbb2222' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tools/mirror/lib/decide.test.mjs`
Expected: FAIL, cannot resolve `./decide.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/tools/mirror/lib/decide.mjs
import { createHash } from 'node:crypto'

/** First 8 hex characters of the SHA-256. Long enough that a collision is not a real risk here. */
export function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8)
}

/**
 * Whether a fetched segment is worth republishing.
 *
 * `identical-bytes` is the case that matters. brouter.de rebuilds every segment weekly
 * regardless of whether OpenStreetMap changed anything inside it, so publishing on
 * `Last-Modified` alone would tell a rider to re-download 137 MB for no change at all.
 */
export function decideSegmentAction({ status, upstreamHash, mirrored }) {
  if (status === 304) return { action: 'skip', reason: 'not-modified' }
  if (mirrored && mirrored.hash === upstreamHash) return { action: 'skip', reason: 'identical-bytes' }
  return { action: 'publish', hash: upstreamHash }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tools/mirror/lib/decide.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/tools/mirror/lib/decide.mjs web/tools/mirror/lib/decide.test.mjs
git commit -m "Mirror: publish only when the bytes differ"
```

---

## Task 4: manifest assembly

**Files:**
- Create: `web/tools/mirror/lib/manifest.mjs`
- Create: `web/tools/mirror/lib/manifest.test.mjs`

**Interfaces:**
- Consumes: `segmentsForBbox` from Task 1, `regions.json` from Task 2.
- Produces: `buildManifest({ regions, segments, picker, generated })` returning the manifest object the app parses in Task 6. `segments` is `Record<string, { url, bytes, hash, changed }>`, `picker` is `{ url, bytes }`.
- Produces: `assertPublishable(manifest, uploadedUrls)`, which throws if the manifest names an object that is not in `uploadedUrls`.

- [ ] **Step 1: Write the failing test**

```javascript
// web/tools/mirror/lib/manifest.test.mjs
import { describe, expect, it } from 'vitest'
import { assertPublishable, buildManifest } from './manifest.mjs'

const segments = {
  W5_N55: { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 27262976, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' },
  W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
}
const regions = [
  { id: 'central-scotland', name: 'Central Scotland', bbox: [-5.0, 55.4, -2.4, 56.4],
    basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 86384407, hash: '1c9d4e77', built: '2026-09-08' } },
]
const picker = { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 }
const generated = '2026-09-11T04:00:00Z'

describe('buildManifest', () => {
  it('derives each region\'s segments from its bbox', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    expect(manifest.regions[0].segments).toEqual(['W5_N55'])
  })

  it('stamps version 1 and carries the picker archive', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    expect(manifest.version).toBe(1)
    expect(manifest.generated).toBe(generated)
    expect(manifest.picker).toEqual(picker)
  })

  it('refuses to build a manifest whose region needs a segment we do not have', () => {
    const orphan = [{ ...regions[0], bbox: [-12.0, 55.4, -11.0, 56.4] }]
    expect(() => buildManifest({ regions: orphan, segments, picker, generated }))
      .toThrow(/W15_N55/)
  })
})

describe('assertPublishable', () => {
  it('passes when every named object was uploaded', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    const urls = new Set([picker.url, segments.W5_N55.url, segments.W5_N50.url, regions[0].basemap.url])
    expect(() => assertPublishable(manifest, urls)).not.toThrow()
  })

  it('throws when the manifest names an object that is not in the bucket', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    const urls = new Set([picker.url, segments.W5_N55.url, segments.W5_N50.url])
    expect(() => assertPublishable(manifest, urls)).toThrow(/central-scotland-1c9d4e77/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tools/mirror/lib/manifest.test.mjs`
Expected: FAIL, cannot resolve `./manifest.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/tools/mirror/lib/manifest.mjs
import { segmentsForBbox } from './geometry.mjs'

/**
 * Assembles the single document every client reads.
 *
 * Region segments are computed here rather than on the phone so that the bucket and the app
 * cannot disagree about what a region needs. The app can still derive them as a check.
 */
export function buildManifest({ regions, segments, picker, generated }) {
  return {
    version: 1,
    generated,
    picker,
    segments,
    regions: regions.map((region) => {
      const needed = segmentsForBbox(region.bbox)
      const missing = needed.filter((name) => !segments[name])
      if (missing.length) {
        throw new Error(`${region.id} needs ${missing.join(', ')}, which the mirror does not have`)
      }
      return {
        id: region.id,
        name: region.name,
        bbox: region.bbox,
        basemap: region.basemap,
        segments: needed,
      }
    }),
  }
}

/**
 * The one failure that breaks every client at once is a manifest naming an object that is
 * not uploaded yet, so the manifest is written last and only after this passes.
 */
export function assertPublishable(manifest, uploadedUrls) {
  const named = [
    manifest.picker.url,
    ...Object.values(manifest.segments).map((s) => s.url),
    ...manifest.regions.map((r) => r.basemap.url),
  ]
  const missing = named.filter((url) => !uploadedUrls.has(url))
  if (missing.length) {
    throw new Error(`manifest names objects that are not in the bucket: ${missing.join(', ')}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tools/mirror/lib/manifest.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/tools/mirror/lib/manifest.mjs web/tools/mirror/lib/manifest.test.mjs
git commit -m "Mirror: manifest assembly, with the upload-before-publish guard"
```

---

## Task 5: the sync scripts

The first task that touches the network and the bucket. Everything it decides was tested in Tasks 1, 3 and 4, so this is wiring.

**Files:**
- Create: `web/tools/mirror/s3.mjs`
- Create: `web/tools/mirror/sync-segments.mjs`
- Create: `web/tools/mirror/cut-basemaps.mjs`
- Create: `web/tools/mirror/README.md`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: `decideSegmentAction`, `hashOf`, `buildManifest`, `assertPublishable`, `segmentsForBbox`, `regions.json`.
- Produces: `manifest.json` in the bucket, in the shape Task 6 parses.
- Reads config from the environment on the VPS only: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. The app itself has no environment variables.

- [ ] **Step 1: Add the dependency and the scripts**

Run: `cd web && npm install --save-dev @aws-sdk/client-s3`

Then add to `web/package.json` under `scripts`:
```json
    "mirror:segments": "node tools/mirror/sync-segments.mjs",
    "mirror:basemaps": "node tools/mirror/cut-basemaps.mjs"
```

- [ ] **Step 2: Write the S3 wrapper**

```javascript
// web/tools/mirror/s3.mjs
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. See tools/mirror/README.md`)
  return value
}

export const BUCKET = required('S3_BUCKET')

export const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION ?? 'eu-central-1',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: true,
})

/** Immutable because every object's name carries its content hash. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** The only mutable object. Five minutes is short enough that an update is noticed same-day. */
export const MANIFEST_CACHE = 'public, max-age=300'

export async function putObject(key, body, { contentType, cacheControl }) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body,
    ContentType: contentType, CacheControl: cacheControl,
  }))
  return key
}

export async function listKeys(prefix) {
  const keys = new Set()
  let token
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }))
    for (const object of page.Contents ?? []) keys.add(object.Key)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

export async function readJson(key) {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    return JSON.parse(await result.Body.transformToString())
  } catch (error) {
    if (error?.name === 'NoSuchKey') return null
    throw error
  }
}
```

- [ ] **Step 3: Write the weekly segment sync**

```javascript
// web/tools/mirror/sync-segments.mjs
/**
 * Mirrors the BRouter segments Britain needs, weekly.
 *
 * Roughly eight conditional requests to brouter.de. That is the entire load this project
 * puts on it, and it replaces one full download per new rider.
 */
import { readFileSync } from 'node:fs'
import { segmentsForBbox } from './lib/geometry.mjs'
import { decideSegmentAction, hashOf } from './lib/decide.mjs'
import { buildManifest, assertPublishable } from './lib/manifest.mjs'
import { IMMUTABLE, MANIFEST_CACHE, listKeys, putObject, readJson } from './s3.mjs'

const UPSTREAM = 'https://brouter.de/brouter/segments4/'
const regions = JSON.parse(readFileSync(new URL('regions.json', import.meta.url), 'utf8'))

const wanted = [...new Set(regions.flatMap((region) => segmentsForBbox(region.bbox)))].sort()
const previous = (await readJson('manifest.json')) ?? { segments: {}, regions: [], picker: null }
const segments = { ...previous.segments }

for (const name of wanted) {
  const mirrored = segments[name]
  const headers = mirrored?.upstreamModified ? { 'If-Modified-Since': mirrored.upstreamModified } : {}
  const response = await fetch(`${UPSTREAM}${name}.rd5`, { headers })

  if (response.status !== 304 && !response.ok) {
    throw new Error(`${name}: brouter.de returned ${response.status}`)
  }

  const body = response.status === 304 ? null : Buffer.from(await response.arrayBuffer())
  const upstreamHash = body ? hashOf(body) : null
  const decision = decideSegmentAction({ status: response.status, upstreamHash, mirrored })

  if (decision.action === 'skip') {
    console.log(`${name}: ${decision.reason}`)
    continue
  }

  const url = `segments4/${name}-${decision.hash}.rd5`
  await putObject(url, body, { contentType: 'application/octet-stream', cacheControl: IMMUTABLE })
  segments[name] = {
    url,
    bytes: body.byteLength,
    hash: decision.hash,
    changed: new Date().toISOString(),
    upstreamModified: response.headers.get('last-modified') ?? undefined,
  }
  console.log(`${name}: published ${url} (${body.byteLength} bytes)`)
}

// Region basemaps are cut by the monthly job; carry forward whatever it last published.
const withBasemaps = regions.map((region) => {
  const existing = previous.regions?.find((r) => r.id === region.id)
  if (!existing?.basemap) {
    throw new Error(`${region.id} has no basemap yet. Run: npm run mirror:basemaps`)
  }
  return { ...region, basemap: existing.basemap }
})

const manifest = buildManifest({
  regions: withBasemaps,
  segments,
  picker: previous.picker,
  generated: new Date().toISOString(),
})

assertPublishable(manifest, await listKeys(''))
await putObject('manifest.json', JSON.stringify(manifest, null, 2), {
  contentType: 'application/json',
  cacheControl: MANIFEST_CACHE,
})
console.log(`manifest published, ${manifest.regions.length} regions`)
```

- [ ] **Step 4: Write the monthly basemap cut**

```javascript
// web/tools/mirror/cut-basemaps.mjs
/**
 * Re-cuts the region basemaps and the picker's backdrop, monthly.
 *
 * Monthly rather than weekly because a Protomaps daily build changes an extract's bytes
 * almost every time, so hashing does not damp basemap churn the way it damps segments. An
 * 86 MB re-download is not worth offering because a cafe moved.
 *
 * Needs the `pmtiles` CLI on PATH and a recent dated build: the dated archives expire.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashOf } from './lib/decide.mjs'
import { buildManifest, assertPublishable } from './lib/manifest.mjs'
import { IMMUTABLE, MANIFEST_CACHE, listKeys, putObject, readJson } from './s3.mjs'

const build = process.argv[2]
if (!build) {
  throw new Error('usage: node cut-basemaps.mjs <YYYYMMDD>   (a recent build.protomaps.com date)')
}
const SOURCE = `https://build.protomaps.com/${build}.pmtiles`
const UK_BBOX = [-8.7, 49.8, 2.0, 61.0]

const regions = JSON.parse(readFileSync(new URL('regions.json', import.meta.url), 'utf8'))
const previous = (await readJson('manifest.json')) ?? { segments: {}, regions: [] }
const work = mkdtempSync(join(tmpdir(), 'free-wheel-cut-'))

const cut = async (name, bbox, maxzoom) => {
  const file = join(work, `${name}.pmtiles`)
  execFileSync('pmtiles', ['extract', SOURCE, file,
    `--bbox=${bbox.join(',')}`, `--maxzoom=${maxzoom}`], { stdio: 'inherit' })
  const body = await readFile(file)
  return { body, hash: hashOf(body), bytes: body.byteLength }
}

const uk = await cut('uk-z10', UK_BBOX, 10)
const picker = { url: `basemap/uk-z10-${uk.hash}.pmtiles`, bytes: uk.bytes }
await putObject(picker.url, uk.body, { contentType: 'application/octet-stream', cacheControl: IMMUTABLE })

const withBasemaps = []
for (const region of regions) {
  const { body, hash, bytes } = await cut(region.id, region.bbox, 14)
  const url = `regions/${region.id}-${hash}.pmtiles`
  await putObject(url, body, { contentType: 'application/octet-stream', cacheControl: IMMUTABLE })
  console.log(`${region.id}: ${url} (${bytes} bytes)`)
  withBasemaps.push({ ...region, basemap: { url, bytes, hash, built: new Date().toISOString().slice(0, 10) } })
}

const manifest = buildManifest({
  regions: withBasemaps,
  segments: previous.segments,
  picker,
  generated: new Date().toISOString(),
})

assertPublishable(manifest, await listKeys(''))
await putObject('manifest.json', JSON.stringify(manifest, null, 2), {
  contentType: 'application/json',
  cacheControl: MANIFEST_CACHE,
})
console.log(`manifest published, ${manifest.regions.length} regions`)
```

- [ ] **Step 5: Write the README**

`web/tools/mirror/README.md` must record: the five environment variables, that `cut-basemaps.mjs` runs first on an empty bucket because `sync-segments.mjs` refuses to publish a region with no basemap, the required CORS rule (`GET` and `HEAD`, `Range` allowed, `Content-Range`, `Content-Length`, `Accept-Ranges`, `ETag` exposed), and the two cron lines:

```cron
17 4 * * 1   cd /srv/free-wheel/web && npm run mirror:segments >> /var/log/free-wheel-mirror.log 2>&1
41 3 1 * *   cd /srv/free-wheel/web && npm run mirror:basemaps -- $(date +\%Y\%m01) >> /var/log/free-wheel-mirror.log 2>&1
```

- [ ] **Step 6: Run the first cut against the real bucket**

Run:
```bash
cd web
S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  npm run mirror:basemaps -- 20260906
S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  npm run mirror:segments
```
Expected: every region uploads, then the segments, then `manifest published, 14 regions`.

- [ ] **Step 7: Verify CORS and ranged reads from a browser origin**

Run:
```bash
curl -sI -H 'Origin: https://free-wheel.vercel.app' -H 'Range: bytes=0-99' \
  "$BUCKET_PUBLIC_URL/manifest.json" | grep -i 'access-control\|content-range\|accept-ranges'
```
Expected: `access-control-allow-origin`, `content-range: bytes 0-99/...`, `accept-ranges: bytes`. If `content-range` is missing, the streamed picker cannot work and the bucket's CORS rule needs `Range` in `AllowedHeaders` before continuing.

- [ ] **Step 8: Commit**

```bash
git add web/tools/mirror web/package.json web/package-lock.json
git commit -m "Mirror: the weekly segment sync and monthly basemap cut"
```

---

## Task 6: manifest types and parsing

**Files:**
- Create: `web/src/data/origin.ts`
- Create: `web/src/data/manifest.ts`
- Create: `web/src/data/manifest.test.ts`

**Interfaces:**
- Produces: `DATA_ORIGIN`, `MANIFEST_URL`, `assetUrl(path: string): string`.
- Produces: `parseManifest(value: unknown): DataManifest`, throwing an `Error` naming the first problem.
- Produces the types every later task uses:
  - `SegmentEntry` is `{ url: string; bytes: number; hash: string; changed: string }`
  - `RegionBasemap` is `{ url: string; bytes: number; hash: string; built: string }`
  - `RegionEntry` is `{ id: string; name: string; bbox: [number, number, number, number]; basemap: RegionBasemap; segments: string[] }`
  - `DataManifest` is `{ version: 1; generated: string; picker: { url: string; bytes: number }; segments: Record<string, SegmentEntry>; regions: RegionEntry[] }`
  - `InstalledRegion` is `{ id: string; basemapHash: string; segmentHashes: Record<string, string>; installedAt: number }`
- Produces: `loadManifest(options?: { fetchImpl?: typeof fetch }): Promise<{ manifest: DataManifest; fresh: boolean }>`. `fresh` is `false` when the copy came from the cache rather than the network, which is what `regionState` needs to answer `unknown` instead of guessing.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/data/manifest.test.ts
import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const good = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N55: { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 27262976, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' },
  },
  regions: [
    {
      id: 'central-scotland',
      name: 'Central Scotland',
      bbox: [-5.0, 55.4, -2.4, 56.4],
      basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 86384407, hash: '1c9d4e77', built: '2026-09-08' },
      segments: ['W5_N55'],
    },
  ],
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest and returns it typed', () => {
    const manifest = parseManifest(structuredClone(good))
    expect(manifest.regions[0].name).toBe('Central Scotland')
    expect(manifest.segments.W5_N55.hash).toBe('aaaa1111')
  })

  it('rejects a version it does not understand rather than half-reading it', () => {
    expect(() => parseManifest({ ...structuredClone(good), version: 2 })).toThrow(/version 2/)
  })

  it('rejects a region that needs a segment the manifest does not describe', () => {
    const broken = structuredClone(good)
    broken.regions[0].segments = ['W5_N55', 'W0_N55']
    expect(() => parseManifest(broken)).toThrow(/W0_N55/)
  })

  it('rejects a zero-byte asset, which means a failed upload', () => {
    const broken = structuredClone(good)
    broken.regions[0].basemap.bytes = 0
    expect(() => parseManifest(broken)).toThrow(/central-scotland/)
  })

  it('rejects anything that is not an object at all', () => {
    expect(() => parseManifest('<!doctype html>')).toThrow(/not a manifest/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/data/manifest.test.ts`
Expected: FAIL, cannot resolve `./manifest`.

- [ ] **Step 3: Write the origin constant**

```typescript
// web/src/data/origin.ts
/**
 * Where the app's data lives.
 *
 * A committed constant rather than an environment variable: `vercel.json` is a static build
 * with no env vars, and the bucket is public anyway. Changing hosts is a one-line commit.
 */
export const DATA_ORIGIN = 'https://free-wheel.fsn1.your-objectstorage.com'

export const MANIFEST_URL = `${DATA_ORIGIN}/manifest.json`

/** Turns a manifest-relative path into a fetchable URL. */
export const assetUrl = (path: string) => `${DATA_ORIGIN}/${path}`
```

Replace `DATA_ORIGIN` with the real public endpoint of the bucket created in Task 5, then confirm it:
```bash
curl -sI "$(node -e "console.log(require('fs').readFileSync('web/src/data/origin.ts','utf8').match(/'(https:[^']+)'/)[1])")/manifest.json" | head -1
```
Expected: `HTTP/2 200`.

- [ ] **Step 4: Write the parser**

```typescript
// web/src/data/manifest.ts
/**
 * The one document the app fetches from the mirror, and the types the rest of the data layer
 * speaks in.
 *
 * Parsing is strict on purpose. A static host answers a missing file with an HTML error page
 * and a 200 in some configurations, and a half-read manifest would show a rider regions that
 * cannot be downloaded. Failing loudly here is the difference between "the mirror is down"
 * and a mystery.
 */

export interface SegmentEntry {
  url: string
  bytes: number
  hash: string
  /** When the bytes last actually differed upstream, not when brouter.de last rebuilt. */
  changed: string
}

export interface RegionBasemap {
  url: string
  bytes: number
  hash: string
  built: string
}

export interface RegionEntry {
  id: string
  name: string
  bbox: [number, number, number, number]
  basemap: RegionBasemap
  segments: string[]
}

export interface DataManifest {
  version: 1
  generated: string
  picker: { url: string; bytes: number }
  segments: Record<string, SegmentEntry>
  regions: RegionEntry[]
}

/** What a phone recorded when it downloaded a region. Compared against the manifest by hash. */
export interface InstalledRegion {
  id: string
  basemapHash: string
  segmentHashes: Record<string, string>
  installedAt: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function asset(value: unknown, where: string): { url: string; bytes: number; hash: string } {
  if (!isObject(value)) throw new Error(`${where}: expected an asset, got ${typeof value}`)
  const { url, bytes, hash } = value
  if (typeof url !== 'string' || url.length === 0) throw new Error(`${where}: missing url`)
  if (typeof bytes !== 'number' || bytes <= 0) throw new Error(`${where}: bytes is ${String(bytes)}`)
  if (typeof hash !== 'string' || hash.length === 0) throw new Error(`${where}: missing hash`)
  return { url, bytes, hash }
}

export function parseManifest(value: unknown): DataManifest {
  if (!isObject(value)) throw new Error('not a manifest: expected an object')
  if (value.version !== 1) throw new Error(`manifest version ${String(value.version)} is not supported`)
  if (!isObject(value.picker)) throw new Error('manifest has no picker archive')
  if (!isObject(value.segments)) throw new Error('manifest has no segments')
  if (!Array.isArray(value.regions)) throw new Error('manifest has no regions')

  const segments: Record<string, SegmentEntry> = {}
  for (const [name, entry] of Object.entries(value.segments)) {
    const { url, bytes, hash } = asset(entry, `segment ${name}`)
    const changed = isObject(entry) && typeof entry.changed === 'string' ? entry.changed : ''
    segments[name] = { url, bytes, hash, changed }
  }

  const regions = value.regions.map((raw): RegionEntry => {
    if (!isObject(raw)) throw new Error('region: expected an object')
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!id) throw new Error('region has no id')
    if (typeof raw.name !== 'string') throw new Error(`${id}: no name`)
    if (!Array.isArray(raw.bbox) || raw.bbox.length !== 4 || raw.bbox.some((n) => typeof n !== 'number')) {
      throw new Error(`${id}: bbox must be four numbers`)
    }
    const basemap = asset(raw.basemap, id)
    const built = isObject(raw.basemap) && typeof raw.basemap.built === 'string' ? raw.basemap.built : ''
    if (!Array.isArray(raw.segments) || raw.segments.some((s) => typeof s !== 'string')) {
      throw new Error(`${id}: segments must be a list of names`)
    }
    for (const name of raw.segments as string[]) {
      if (!segments[name]) throw new Error(`${id} needs segment ${name}, which the manifest does not describe`)
    }
    return {
      id,
      name: raw.name,
      bbox: raw.bbox as [number, number, number, number],
      basemap: { ...basemap, built },
      segments: raw.segments as string[],
    }
  })

  const picker = value.picker as Record<string, unknown>
  if (typeof picker.url !== 'string' || typeof picker.bytes !== 'number') {
    throw new Error('manifest picker is malformed')
  }

  return {
    version: 1,
    generated: typeof value.generated === 'string' ? value.generated : '',
    picker: { url: picker.url, bytes: picker.bytes },
    segments,
    regions,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/data/manifest.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing test for the cached loader**

Append to `web/src/data/manifest.test.ts`:

```typescript
import { beforeEach, vi } from 'vitest'
import { loadManifest } from './manifest'

describe('loadManifest', () => {
  beforeEach(() => localStorage.clear())

  it('fetches, caches, and reports the copy as fresh', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(good), { status: 200 }))
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(true)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
    expect(localStorage.getItem('free-wheel.manifest')).toContain('central-scotland')
  })

  it('falls back to the cache when the network is gone, and says the copy is not fresh', async () => {
    localStorage.setItem('free-wheel.manifest', JSON.stringify(good))
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(false)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
  })

  it('throws when it is offline and has never cached anything', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    await expect(loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/no saved copy/)
  })

  it('keeps the cached copy when the server answers with something unparseable', async () => {
    localStorage.setItem('free-wheel.manifest', JSON.stringify(good))
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', { status: 200 }))
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(false)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
  })
})
```

The vitest environment must provide `localStorage`. If `npx vitest run` reports it undefined, set `environment: 'jsdom'` for this file with a `// @vitest-environment jsdom` comment at the top rather than changing the whole suite's environment.

- [ ] **Step 7: Run test to verify it fails**

Run: `cd web && npx vitest run src/data/manifest.test.ts`
Expected: FAIL, `loadManifest` is not exported.

- [ ] **Step 8: Write the cached loader**

```typescript
// append to web/src/data/manifest.ts
import { MANIFEST_URL } from './origin'

const CACHE_KEY = 'free-wheel.manifest'

/**
 * The manifest, from the network if possible and from the last good copy if not.
 *
 * `fresh` matters more than it looks. An offline phone cannot know whether its regions are
 * current, and reporting them as current would be a guess presented as a fact. The whole
 * freshness story depends on this flag being honest.
 *
 * A static host can answer a missing file with an HTML error page and a 200, so a response
 * that does not parse is treated exactly like a failed request: keep the cached copy.
 */
export async function loadManifest(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ manifest: DataManifest; fresh: boolean }> {
  const doFetch = options.fetchImpl ?? fetch
  const cached = localStorage.getItem(CACHE_KEY)

  try {
    const response = await doFetch(MANIFEST_URL, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`the mirror returned ${response.status}`)
    const text = await response.text()
    const manifest = parseManifest(JSON.parse(text))
    localStorage.setItem(CACHE_KEY, text)
    return { manifest, fresh: true }
  } catch (error) {
    if (!cached) {
      throw new Error(
        `could not reach the mirror and there is no saved copy: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return { manifest: parseManifest(JSON.parse(cached)), fresh: false }
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd web && npx vitest run src/data/manifest.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 10: Commit**

```bash
git add web/src/data/origin.ts web/src/data/manifest.ts web/src/data/manifest.test.ts
git commit -m "Data: manifest types, a strict parser, and an honest offline copy"
```

---

## Task 7: what a region costs, and whether it is current

**Files:**
- Create: `web/src/data/regions.ts`
- Create: `web/src/data/regions.test.ts`

**Interfaces:**
- Consumes: `DataManifest`, `RegionEntry`, `InstalledRegion` from Task 6.
- Produces: `regionState(region, installed, manifestIsFresh): RegionState` where `RegionState` is `'not-installed' | 'current' | 'road-data-outdated' | 'map-outdated' | 'unknown'`.
- Produces: `downloadPlan(region, manifest, installed): { items: DownloadItem[]; bytes: number }` where `DownloadItem` is `{ kind: 'basemap' | 'segment'; key: string; url: string; bytes: number; hash: string }`. `key` is the region id for a basemap and the segment name for a segment.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/data/regions.test.ts
import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from './manifest'
import { downloadPlan, regionState } from './regions'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
  },
  regions: [
    { id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
      basemap: { url: 'regions/wessex-1111aaaa.pmtiles', bytes: 90000000, hash: '1111aaaa', built: '2026-09-08' },
      segments: ['W5_N50'] },
    { id: 'south-west-england', name: 'South West England', bbox: [-5.8, 49.9, -2.4, 51.5],
      basemap: { url: 'regions/south-west-england-2222bbbb.pmtiles', bytes: 70000000, hash: '2222bbbb', built: '2026-09-08' },
      segments: ['W5_N50'] },
  ],
}
const wessex = manifest.regions[0]
const southWest = manifest.regions[1]

const installedWessex: InstalledRegion = {
  id: 'wessex',
  basemapHash: '1111aaaa',
  segmentHashes: { W5_N50: 'bbbb2222' },
  installedAt: Date.parse('2026-09-09T00:00:00Z'),
}

describe('regionState', () => {
  it('reports a region nobody has downloaded', () => {
    expect(regionState(wessex, undefined, true)).toBe('not-installed')
  })

  it('reports a region whose hashes all match', () => {
    expect(regionState(wessex, installedWessex, true)).toBe('current')
  })

  it('leads with the road data when both are outdated, because that is the half that misroutes', () => {
    const stale = { ...installedWessex, basemapHash: 'old', segmentHashes: { W5_N50: 'old' } }
    expect(regionState(wessex, stale, true)).toBe('road-data-outdated')
  })

  it('reports an outdated map on its own', () => {
    expect(regionState(wessex, { ...installedWessex, basemapHash: 'old' }, true)).toBe('map-outdated')
  })

  it('says unknown rather than current when the manifest could not be refreshed', () => {
    expect(regionState(wessex, installedWessex, false)).toBe('unknown')
    expect(regionState(wessex, undefined, false)).toBe('not-installed')
  })
})

describe('downloadPlan', () => {
  it('costs a fresh region as its basemap plus its segments', () => {
    const plan = downloadPlan(wessex, manifest, [])
    expect(plan.items.map((i) => i.key)).toEqual(['wessex', 'W5_N50'])
    expect(plan.bytes).toBe(90000000 + 143654912)
  })

  it('does not re-download a 137 MB segment a neighbouring region already installed', () => {
    const plan = downloadPlan(southWest, manifest, [installedWessex])
    expect(plan.items.map((i) => i.key)).toEqual(['south-west-england'])
    expect(plan.bytes).toBe(70000000)
  })

  it('does re-download a shared segment whose bytes changed upstream', () => {
    const stale = { ...installedWessex, segmentHashes: { W5_N50: 'older111' } }
    const plan = downloadPlan(southWest, manifest, [stale])
    expect(plan.items.map((i) => i.key)).toEqual(['south-west-england', 'W5_N50'])
  })

  it('skips the basemap when only the road data changed', () => {
    const stale = { ...installedWessex, segmentHashes: { W5_N50: 'older111' } }
    const plan = downloadPlan(wessex, manifest, [stale])
    expect(plan.items.map((i) => i.key)).toEqual(['W5_N50'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/data/regions.test.ts`
Expected: FAIL, cannot resolve `./regions`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// web/src/data/regions.ts
import { assetUrl } from './origin'
import type { DataManifest, InstalledRegion, RegionEntry } from './manifest'

export type RegionState =
  | 'not-installed'
  | 'current'
  | 'road-data-outdated'
  | 'map-outdated'
  | 'unknown'

export interface DownloadItem {
  kind: 'basemap' | 'segment'
  /** Region id for a basemap, segment name for a segment. */
  key: string
  url: string
  bytes: number
  hash: string
}

/**
 * Whether an installed region still matches the mirror.
 *
 * `unknown` exists because an offline phone has no way to tell, and claiming `current` would
 * be a guess dressed as a fact. Road data leads when both are stale: an old basemap is a
 * cosmetic problem, and an old segment routes you down a road that is not there.
 */
export function regionState(
  region: RegionEntry,
  installed: InstalledRegion | undefined,
  manifestIsFresh: boolean,
): RegionState {
  if (!installed) return 'not-installed'
  if (!manifestIsFresh) return 'unknown'
  const roadDataStale = region.segments.some(
    (name) => installed.segmentHashes[name] !== manifest_hash(region, name),
  )
  if (roadDataStale) return 'road-data-outdated'
  if (installed.basemapHash !== region.basemap.hash) return 'map-outdated'
  return 'current'

  // Local helper keeps the hash lookup honest about needing the manifest entry, not the region.
  function manifest_hash(_region: RegionEntry, _name: string): string {
    throw new Error('replaced below')
  }
}

/**
 * What actually has to be downloaded, in the order it should happen.
 *
 * Segments are shared: `W5_N50` covers most of England and Wales, so a rider who already has
 * Wessex should not download 137 MB again for the South West.
 */
export function downloadPlan(
  region: RegionEntry,
  manifest: DataManifest,
  installed: InstalledRegion[],
): { items: DownloadItem[]; bytes: number } {
  const mine = installed.find((r) => r.id === region.id)
  const items: DownloadItem[] = []

  if (mine?.basemapHash !== region.basemap.hash) {
    items.push({
      kind: 'basemap',
      key: region.id,
      url: assetUrl(region.basemap.url),
      bytes: region.basemap.bytes,
      hash: region.basemap.hash,
    })
  }

  for (const name of region.segments) {
    const entry = manifest.segments[name]
    const haveCurrent = installed.some((r) => r.segmentHashes[name] === entry.hash)
    if (haveCurrent) continue
    items.push({
      kind: 'segment',
      key: name,
      url: assetUrl(entry.url),
      bytes: entry.bytes,
      hash: entry.hash,
    })
  }

  return { items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}
```

- [ ] **Step 4: Fix `regionState` so it reads hashes from the manifest**

The sketch above has a deliberate hole: `regionState` needs the manifest's segment hashes, which the region alone does not carry. Change the signature to take the manifest and use it:

```typescript
export function regionState(
  region: RegionEntry,
  installed: InstalledRegion | undefined,
  manifestIsFresh: boolean,
  segments: DataManifest['segments'],
): RegionState {
  if (!installed) return 'not-installed'
  if (!manifestIsFresh) return 'unknown'
  const roadDataStale = region.segments.some(
    (name) => installed.segmentHashes[name] !== segments[name]?.hash,
  )
  if (roadDataStale) return 'road-data-outdated'
  if (installed.basemapHash !== region.basemap.hash) return 'map-outdated'
  return 'current'
}
```

Update every call in `regions.test.ts` to pass `manifest.segments` as the fourth argument, and delete the placeholder helper.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/data/regions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/data/regions.ts web/src/data/regions.test.ts
git commit -m "Data: region freshness and what a download actually costs"
```

---

## Task 8: resumable downloads

**Files:**
- Create: `web/src/engine/downloads.ts`
- Create: `web/src/engine/downloads.test.ts`

**Interfaces:**
- Produces: `resumeDecision(existing: { bytes: number; hash: string | null }, target: { bytes: number; hash: string }): ResumeDecision`, where `ResumeDecision` is `{ action: 'start' } | { action: 'resume'; at: number } | { action: 'done' }`.
- Produces: `ByteSink`, which is `{ size(): number; truncate(to: number): void; write(chunk: Uint8Array, at: number): void; flush(): void }`.
- Produces: `downloadInto(sink: ByteSink, url: string, expectedBytes: number, options: { from?: number; fetchImpl?: typeof fetch; onProgress?: (received: number, total: number) => void }): Promise<void>`.

A phone drops wifi at 90% of a 137 MB file often enough that resume is not a nicety. The sink is an interface so this is testable without OPFS, which is Worker-only on iOS and unavailable under vitest.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/engine/downloads.test.ts
import { describe, expect, it, vi } from 'vitest'
import { downloadInto, resumeDecision, type ByteSink } from './downloads'

function fakeSink(initial = new Uint8Array(0)) {
  let bytes = initial
  const sink: ByteSink & { readonly bytes: Uint8Array } = {
    size: () => bytes.length,
    truncate: (to) => {
      bytes = bytes.slice(0, to)
    },
    write: (chunk, at) => {
      if (at + chunk.length > bytes.length) {
        const grown = new Uint8Array(at + chunk.length)
        grown.set(bytes)
        bytes = grown
      }
      bytes.set(chunk, at)
    },
    flush: () => {},
    get bytes() {
      return bytes
    },
  }
  return sink
}

const body = (text: string) => new TextEncoder().encode(text)

describe('resumeDecision', () => {
  it('starts from scratch when nothing is on disk', () => {
    expect(resumeDecision({ bytes: 0, hash: null }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('resumes a partial download of the same file', () => {
    expect(resumeDecision({ bytes: 40, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'resume', at: 40 })
  })

  it('is done when the file is already the right length', () => {
    expect(resumeDecision({ bytes: 100, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'done' })
  })

  it('starts over when a different version is half-written, rather than splicing two files', () => {
    expect(resumeDecision({ bytes: 40, hash: 'older111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('starts over when the file on disk is longer than the target', () => {
    expect(resumeDecision({ bytes: 140, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })
})

describe('downloadInto', () => {
  it('writes a whole file and reports progress', async () => {
    const sink = fakeSink()
    const seen: number[] = []
    const fetchImpl = vi.fn(async () => new Response(body('abcdefghij'), { status: 200 }))
    await downloadInto(sink, 'https://example/x', 10, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress: (received) => seen.push(received),
    })
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcdefghij')
    expect(seen.at(-1)).toBe(10)
  })

  it('asks for the rest with a Range header and appends it', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () =>
      new Response(body('efghij'), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } }),
    )
    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Range: 'bytes=4-' } })
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcdefghij')
  })

  it('restarts from zero when the server ignores the Range and sends the whole file', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () => new Response(body('ABCDEFGHIJ'), { status: 200 }))
    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(new TextDecoder().decode(sink.bytes)).toBe('ABCDEFGHIJ')
  })

  it('throws when the download is short, which is what truncation looks like', async () => {
    const sink = fakeSink()
    const fetchImpl = vi.fn(async () => new Response(body('abc'), { status: 200 }))
    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/expected 10 bytes, wrote 3/)
  })

  it('reports an HTTP error rather than writing the error page into the file', async () => {
    const sink = fakeSink()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/404/)
    expect(sink.bytes.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/downloads.test.ts`
Expected: FAIL, cannot resolve `./downloads`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// web/src/engine/downloads.ts
/**
 * Streamed, resumable downloads into OPFS.
 *
 * Two things shape this. A phone loses wifi partway through a 137 MB segment often enough
 * that resuming matters, and the bytes must never be buffered whole: `arrayBuffer()` on a
 * segment file would be a 137 MB spike on a device with a tab budget.
 *
 * Integrity is a length check rather than a hash. `SubtleCrypto` has no streaming digest, so
 * hashing would mean holding the file in memory, and the realistic failure here is a
 * truncated download, which the length catches for free.
 */

export type ResumeDecision =
  | { action: 'start' }
  | { action: 'resume'; at: number }
  | { action: 'done' }

/** Somewhere to put bytes. An interface so this is testable without OPFS, which is Worker-only. */
export interface ByteSink {
  size(): number
  truncate(to: number): void
  write(chunk: Uint8Array, at: number): void
  flush(): void
}

export interface DownloadOptions {
  from?: number
  fetchImpl?: typeof fetch
  onProgress?: (received: number, total: number) => void
}

/**
 * Whether a partly-written file can be continued.
 *
 * The hash comparison is what stops the worst outcome: half of last month's segment followed
 * by the tail of this month's, which is a file that parses and routes wrongly.
 */
export function resumeDecision(
  existing: { bytes: number; hash: string | null },
  target: { bytes: number; hash: string },
): ResumeDecision {
  if (existing.hash !== target.hash) return { action: 'start' }
  if (existing.bytes === target.bytes) return { action: 'done' }
  if (existing.bytes === 0 || existing.bytes > target.bytes) return { action: 'start' }
  return { action: 'resume', at: existing.bytes }
}

export async function downloadInto(
  sink: ByteSink,
  url: string,
  expectedBytes: number,
  options: DownloadOptions = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const from = options.from ?? 0
  const response = await doFetch(url, from > 0 ? { headers: { Range: `bytes=${from}-` } } : {})

  if (!response.ok) {
    throw new Error(`${url}: server returned ${response.status}`)
  }
  if (!response.body) {
    throw new Error(`${url}: response had no body`)
  }

  // A server that ignores Range answers 200 with the whole file. Writing that at the resume
  // offset would produce a file the right length and wrong throughout.
  let offset = response.status === 206 ? from : 0
  if (offset === 0) sink.truncate(0)

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.write(value, offset)
      offset += value.byteLength
      options.onProgress?.(offset, expectedBytes)
    }
  } finally {
    sink.flush()
  }

  if (offset !== expectedBytes) {
    throw new Error(`${url}: expected ${expectedBytes} bytes, wrote ${offset}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/downloads.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/downloads.ts web/src/engine/downloads.test.ts
git commit -m "Engine: resumable streamed downloads with a length check"
```

---

## Task 9: region records and the Worker API

**Files:**
- Create: `web/src/engine/regionStore.ts`
- Create: `web/src/engine/regionStore.test.ts`
- Modify: `web/src/engine/engineApi.ts`

**Interfaces:**
- Consumes: `openHandle`, `refreshSize`, `removeFile` from `opfsVfs.ts`; `installedTiles`, `SEGMENT_DIR`, `BASEMAP_DIR` from `tileStore.ts`; `downloadInto`, `resumeDecision` from Task 8; `downloadPlan` from Task 7.
- Produces: `recordAfterDownload(records, region, manifest, at): InstalledRegion[]` and `recordsAfterRemoval(records, id): { records: InstalledRegion[]; deleteSegments: string[]; deleteBasemap: string }`, both pure.
- Produces on `engineApi`: `downloadRegion(region, manifest, onProgress?)`, `installedRegions()`, `removeRegion(id)`.
- Local paths: a region basemap is `/basemap/<region id>.pmtiles`, a segment stays `/segments4/<NAME>.rd5` because BRouter finds it by name.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/engine/regionStore.test.ts
import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import { recordAfterDownload, recordsAfterRemoval } from './regionStore'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
  },
  regions: [
    { id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
      basemap: { url: 'regions/wessex-1111aaaa.pmtiles', bytes: 90000000, hash: '1111aaaa', built: '2026-09-08' },
      segments: ['W5_N50'] },
    { id: 'south-west-england', name: 'South West England', bbox: [-5.8, 49.9, -2.4, 51.5],
      basemap: { url: 'regions/south-west-england-2222bbbb.pmtiles', bytes: 70000000, hash: '2222bbbb', built: '2026-09-08' },
      segments: ['W5_N50'] },
  ],
}

const wessex: InstalledRegion = {
  id: 'wessex', basemapHash: '1111aaaa', segmentHashes: { W5_N50: 'bbbb2222' }, installedAt: 1,
}

describe('recordAfterDownload', () => {
  it('adds a region with the hashes it was downloaded at', () => {
    const records = recordAfterDownload([], manifest.regions[0], manifest, 1)
    expect(records).toEqual([wessex])
  })

  it('replaces an earlier record for the same region rather than duplicating it', () => {
    const stale = { ...wessex, basemapHash: 'old', installedAt: 0 }
    const records = recordAfterDownload([stale], manifest.regions[0], manifest, 2)
    expect(records).toHaveLength(1)
    expect(records[0].basemapHash).toBe('1111aaaa')
    expect(records[0].installedAt).toBe(2)
  })
})

describe('recordsAfterRemoval', () => {
  it('deletes the segment when no other region needs it', () => {
    const result = recordsAfterRemoval([wessex], 'wessex')
    expect(result.records).toEqual([])
    expect(result.deleteSegments).toEqual(['W5_N50'])
    expect(result.deleteBasemap).toBe('wessex.pmtiles')
  })

  it('keeps a shared segment that another installed region still routes on', () => {
    const southWest = recordAfterDownload([wessex], manifest.regions[1], manifest, 3)
    const result = recordsAfterRemoval(southWest, 'wessex')
    expect(result.records.map((r) => r.id)).toEqual(['south-west-england'])
    expect(result.deleteSegments).toEqual([])
  })

  it('is a no-op for a region that is not installed', () => {
    const result = recordsAfterRemoval([wessex], 'kent-sussex')
    expect(result.records).toEqual([wessex])
    expect(result.deleteSegments).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/regionStore.test.ts`
Expected: FAIL, cannot resolve `./regionStore`.

- [ ] **Step 3: Write the pure record logic and the OPFS store**

```typescript
// web/src/engine/regionStore.ts
import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { openHandle, refreshSize, removeFile } from './opfsVfs'
import { BASEMAP_DIR, SEGMENT_DIR } from './tileStore'

/** Where the region records live. Beside the tile manifest, not inside it. */
const RECORDS_PATH = '/regions.json'

/** A region's basemap on this phone. The hash lives in the record, not the file name. */
export const basemapFileFor = (id: string) => `${id}.pmtiles`

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function recordAfterDownload(
  records: InstalledRegion[],
  region: RegionEntry,
  manifest: DataManifest,
  at: number,
): InstalledRegion[] {
  const segmentHashes: Record<string, string> = {}
  for (const name of region.segments) segmentHashes[name] = manifest.segments[name].hash
  const record: InstalledRegion = {
    id: region.id,
    basemapHash: region.basemap.hash,
    segmentHashes,
    installedAt: at,
  }
  return [...records.filter((r) => r.id !== region.id), record]
}

/**
 * Removing a region must not remove a segment another one still needs.
 *
 * `W5_N50` covers most of England and Wales, so deleting Wessex while the South West is
 * installed would silently break routing there. The file is 137 MB, so the mistake also
 * costs a long re-download.
 */
export function recordsAfterRemoval(
  records: InstalledRegion[],
  id: string,
): { records: InstalledRegion[]; deleteSegments: string[]; deleteBasemap: string } {
  const going = records.find((r) => r.id === id)
  if (!going) return { records, deleteSegments: [], deleteBasemap: '' }

  const remaining = records.filter((r) => r.id !== id)
  const stillNeeded = new Set(remaining.flatMap((r) => Object.keys(r.segmentHashes)))
  return {
    records: remaining,
    deleteSegments: Object.keys(going.segmentHashes).filter((name) => !stillNeeded.has(name)),
    deleteBasemap: basemapFileFor(id),
  }
}

export async function readRecords(): Promise<InstalledRegion[]> {
  const handle = await openHandle(RECORDS_PATH)
  const size = handle.getSize()
  if (size === 0) return []
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    const parsed: unknown = JSON.parse(decoder.decode(buffer))
    return Array.isArray(parsed) ? (parsed as InstalledRegion[]) : []
  } catch {
    return [] // a corrupt record costs a re-download, not a crash
  }
}

export async function writeRecords(records: InstalledRegion[]): Promise<void> {
  const handle = await openHandle(RECORDS_PATH)
  const bytes = encoder.encode(JSON.stringify(records))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(RECORDS_PATH)
}

export async function deleteRegionFiles(deleteSegments: string[], deleteBasemap: string): Promise<void> {
  for (const name of deleteSegments) await removeFile(`${SEGMENT_DIR}/${name}.rd5`)
  if (deleteBasemap) await removeFile(`${BASEMAP_DIR}/${deleteBasemap}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/regionStore.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the Worker API**

Add to `engineApi` in `web/src/engine/engineApi.ts`, importing `downloadInto`, `resumeDecision` from `./downloads`, `downloadPlan` from `../data/regions`, and the region store functions:

```typescript
  /**
   * Downloads a region's basemap and routing segments into OPFS.
   *
   * Runs here because sync access handles are Worker-only on iOS, and finishes by calling
   * `installedTiles()` again: that call is what registers `/segments4` in the VFS's in-memory
   * directory registry, and skipping it makes BRouter report that the segment directory does
   * not exist while the file sits in OPFS. It only shows up on a cold start.
   */
  async downloadRegion(
    region: RegionEntry,
    manifest: DataManifest,
    onProgress?: (progress: RegionProgress) => void,
  ): Promise<InstalledRegion[]> {
    const records = await readRecords()
    const plan = downloadPlan(region, manifest, records)
    let doneBytes = 0

    for (const item of plan.items) {
      const path =
        item.kind === 'basemap'
          ? `${BASEMAP_DIR}/${basemapFileFor(region.id)}`
          : `${SEGMENT_DIR}/${item.key}.rd5`

      const handle = await openHandle(path)
      const recordedHash = await readPartialHash(path)
      const decision = resumeDecision(
        { bytes: handle.getSize(), hash: recordedHash },
        { bytes: item.bytes, hash: item.hash },
      )

      if (decision.action !== 'done') {
        await writePartialHash(path, item.hash)
        const sink = {
          size: () => handle.getSize(),
          truncate: (to: number) => handle.truncate(to),
          write: (chunk: Uint8Array, at: number) => {
            handle.write(chunk, { at })
          },
          flush: () => handle.flush(),
        }
        await downloadInto(sink, item.url, item.bytes, {
          from: decision.action === 'resume' ? decision.at : 0,
          onProgress: (received) =>
            onProgress?.({
              key: item.key,
              kind: item.kind,
              received,
              total: item.bytes,
              overallReceived: doneBytes + received,
              overallTotal: plan.bytes,
              state: 'downloading',
            }),
        })
        refreshSize(path)
      }

      doneBytes += item.bytes
      await clearPartialHash(path)
      onProgress?.({
        key: item.key, kind: item.kind, received: item.bytes, total: item.bytes,
        overallReceived: doneBytes, overallTotal: plan.bytes, state: 'complete',
      })
    }

    const updated = recordAfterDownload(records, region, manifest, Date.now())
    await writeRecords(updated)
    // Opens the new .rd5 handles and registers /segments4. Do not remove.
    await installedTiles()
    return updated
  },

  async installedRegions(): Promise<InstalledRegion[]> {
    return readRecords()
  },

  async removeRegion(id: string): Promise<InstalledRegion[]> {
    const records = await readRecords()
    const { records: remaining, deleteSegments, deleteBasemap } = recordsAfterRemoval(records, id)
    await deleteRegionFiles(deleteSegments, deleteBasemap)
    await writeRecords(remaining)
    return remaining
  },
```

`RegionProgress` goes in `web/src/engine/downloads.ts` so both sides import it:

```typescript
export interface RegionProgress {
  key: string
  kind: 'basemap' | 'segment'
  received: number
  total: number
  overallReceived: number
  overallTotal: number
  state: 'downloading' | 'complete' | 'failed'
}
```

`readPartialHash`, `writePartialHash` and `clearPartialHash` go in `regionStore.ts`, backed by a `/downloads.json` map of path to hash. They are what makes `resumeDecision` able to tell a half-written *current* file from a half-written *older* one:

```typescript
const PARTIALS_PATH = '/downloads.json'

async function readPartials(): Promise<Record<string, string>> {
  const handle = await openHandle(PARTIALS_PATH)
  const size = handle.getSize()
  if (size === 0) return {}
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    return JSON.parse(decoder.decode(buffer)) as Record<string, string>
  } catch {
    return {}
  }
}

async function writePartials(partials: Record<string, string>): Promise<void> {
  const handle = await openHandle(PARTIALS_PATH)
  const bytes = encoder.encode(JSON.stringify(partials))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(PARTIALS_PATH)
}

export async function readPartialHash(path: string): Promise<string | null> {
  return (await readPartials())[path] ?? null
}

export async function writePartialHash(path: string, hash: string): Promise<void> {
  const partials = await readPartials()
  partials[path] = hash
  await writePartials(partials)
}

export async function clearPartialHash(path: string): Promise<void> {
  const partials = await readPartials()
  delete partials[path]
  await writePartials(partials)
}
```

- [ ] **Step 6: Verify the whole suite and the type build**

Run: `cd web && npx vitest run && npm run build`
Expected: all tests pass, `tsc -b` clean, Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/engine/regionStore.ts web/src/engine/regionStore.test.ts web/src/engine/downloads.ts web/src/engine/engineApi.ts
git commit -m "Engine: download a region, and never delete a shared segment"
```

---

## Task 10: streaming the picker's backdrop

**Files:**
- Modify: `web/src/map/opfsPmtiles.ts`
- Modify: `web/src/ride/useMapLibre.ts`
- Create: `web/src/map/remoteBasemap.test.ts`

**Interfaces:**
- Produces: `mountRemoteBasemap(url: string)` in `opfsPmtiles.ts`, returning `{ bytes: 0, minZoom, maxZoom, center }` in the same shape `mountBasemap` returns.
- Produces: `showRemote(url: string): Promise<void>` on the object `useMapLibre` returns.

`basemapStyle()` needs no change. Its `archive` argument is only ever interpolated into `` url: `pmtiles://${archive}` ``, and the `pmtiles` library's `Protocol` already falls back to a network `FetchSource` for a key it does not recognise. The existing comments treat that fallback as a hazard; here it is the mechanism. The test below pins that so a future refactor of `basemapStyle` cannot quietly break the picker.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/map/remoteBasemap.test.ts
import { describe, expect, it } from 'vitest'
import { basemapStyle } from './style'

describe('basemapStyle with a remote archive', () => {
  it('addresses an https archive through the pmtiles protocol', () => {
    const style = basemapStyle('https://example.com/uk-z10-8f3a1c2d.pmtiles', 'dark', 'rideable')
    const source = style.sources.basemap as { url: string }
    expect(source.url).toBe('pmtiles://https://example.com/uk-z10-8f3a1c2d.pmtiles')
  })

  it('still addresses a local archive by bare name', () => {
    const style = basemapStyle('edinburgh.pmtiles', 'dark', 'rideable')
    const source = style.sources.basemap as { url: string }
    expect(source.url).toBe('pmtiles://edinburgh.pmtiles')
  })
})
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `cd web && npx vitest run src/map/remoteBasemap.test.ts`
Expected: PASS, 2 tests. This one is a characterisation test, not a red-green cycle: it records behaviour the picker now depends on.

- [ ] **Step 3: Add `mountRemoteBasemap`**

In `web/src/map/opfsPmtiles.ts`, beside `mountBasemap`:

```typescript
/**
 * Makes a remote archive available to the map, read by HTTP range.
 *
 * Nothing is downloaded. The region picker shows Britain at z5 to z8 and pulls a few hundred
 * kilobytes out of a 61 MB archive, which is why the first screen does not have to wait for a
 * download to show a real map.
 */
export async function mountRemoteBasemap(url: string) {
  registerPmtilesProtocol()
  const archive = new PMTiles(url)
  const header = await archive.getHeader()
  return {
    name: url,
    bytes: 0,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    center: [header.centerLon, header.centerLat] as [number, number],
  }
}
```

- [ ] **Step 4: Add `showRemote` to the map controller**

In `web/src/ride/useMapLibre.ts`, add a `showRemote` callback beside `show`. It follows `show` exactly, with three differences: it calls `mountRemoteBasemap(url)` instead of `mountBasemap(name)`, it does not touch `archives` or `active` (a streamed archive is not installed, and the ride screen must not think it is), and it opens on Britain:

```typescript
  const showRemote = useCallback(
    async (url: string) => {
      setError(null)
      setStyleReady(false)
      try {
        const header = await mountRemoteBasemap(url)
        map.current?.remove()
        const created = new MapLibreMap({
          container: container.current!,
          style: basemapStyle(url, themeRef.current, pathModeRef.current),
          center: [-3.2, 54.8],
          zoom: 4.6,
          maxZoom: Math.min(header.maxZoom + 5, 19),
          attributionControl: false,
          pitchWithRotate: false,
          dragRotate: false,
        })
        created.touchZoomRotate.disableRotation()
        created.addControl(new AttributionControl({ compact: true }), 'bottom-left')
        created.on('error', (e) => setError(e.error?.message ?? 'map error'))
        created.once('load', () => setStyleReady(true))
        map.current = created
        setStatus('ready')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    },
    [container],
  )
```

Add `showRemote` to the returned object beside `show`.

- [ ] **Step 5: Verify by hand in the browser**

Run: `cd web && npm run dev`, then in the devtools console on the running app:
```javascript
// with the app open and no basemap installed
await window.__fw?.showRemote?.('https://<bucket>/basemap/uk-z10-<hash>.pmtiles')
```
If no debug hook exists, instead check that the picker in Task 12 draws Britain. Expected either way: a map of Britain appears within a couple of seconds, and the Network panel shows a handful of range requests to the bucket rather than a 61 MB transfer.

- [ ] **Step 6: Commit**

```bash
git add web/src/map/opfsPmtiles.ts web/src/ride/useMapLibre.ts web/src/map/remoteBasemap.test.ts
git commit -m "Map: stream a remote PMTiles archive for the region picker"
```

---

## Task 11: region outlines on the map

**Files:**
- Create: `web/src/setup/regionLayers.ts`
- Create: `web/src/setup/regionLayers.test.ts`

**Interfaces:**
- Consumes: `RegionEntry` from Task 6, `RegionState` from Task 7.
- Produces: `regionsGeoJson(regions: RegionEntry[], states: Record<string, RegionState>): GeoJSON.FeatureCollection`.
- Produces: `ensureRegionLayers(map: MapLibreMap)` and `setRegionData(map, collection)`, following the pattern in `web/src/ride/routeLayers.ts`.
- Produces: `REGION_FILL_LAYER = 'regions-fill'` and `REGION_LINE_LAYER = 'regions-line'`, the layer ids a click handler queries.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/setup/regionLayers.test.ts
import { describe, expect, it } from 'vitest'
import type { RegionEntry } from '../data/manifest'
import { chroma, deltaE2000 } from '../map/colour'
import { PALETTES } from '../map/style'
import { REGION_COLOURS, regionsGeoJson } from './regionLayers'

const regions: RegionEntry[] = [
  { id: 'central-scotland', name: 'Central Scotland', bbox: [-5.0, 55.4, -2.4, 56.4],
    basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 1, hash: '1c9d4e77', built: '2026-09-08' },
    segments: ['W5_N55'] },
]

describe('regionsGeoJson', () => {
  it('closes each ring, which an unclosed polygon renders as a sliver', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0]
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])
  })

  it('winds the ring anticlockwise from the south-west corner', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0]
    expect(ring[0]).toEqual([-5.0, 55.4])
    expect(ring[1]).toEqual([-2.4, 55.4])
    expect(ring[2]).toEqual([-2.4, 56.4])
  })

  it('carries the id, name and state so the layers can paint and the click can identify', () => {
    const [feature] = regionsGeoJson(regions, { 'central-scotland': 'current' }).features
    expect(feature.properties).toEqual({
      id: 'central-scotland',
      name: 'Central Scotland',
      state: 'current',
    })
  })

  it('defaults a region with no record to not-installed', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    expect(feature.properties?.state).toBe('not-installed')
  })
})

describe('REGION_COLOURS', () => {
  it('holds every boundary colour above the chroma floor the route lines use', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      expect(chroma(colour), `${name} (${colour})`).toBeGreaterThanOrEqual(45)
    }
  })

  it('keeps every boundary clear of both basemap palettes, labels included', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      for (const theme of ['dark', 'light'] as const) {
        for (const [key, against] of Object.entries(PALETTES[theme].line)) {
          expect(deltaE2000(colour, against), `${name} vs ${theme}.line.${key}`)
            .toBeGreaterThanOrEqual(16)
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/setup/regionLayers.test.ts`
Expected: FAIL, cannot resolve `./regionLayers`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// web/src/setup/regionLayers.ts
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import type { RegionState } from '../data/regions'

/**
 * The three states a boundary can be in.
 *
 * Chosen on chroma, like the route lines and for the same reason: every stroke in both
 * basemap palettes measures C 15.4 or less, so anything at C 45 or above cannot be mistaken
 * for a boundary that belongs to the map. `regionLayers.test.ts` asserts the floor.
 */
export const REGION_COLOURS = {
  available: '#7aa2f7',
  current: '#3ddc97',
  outdated: '#ffb347',
} as const

export const REGION_SOURCE = 'regions'
export const REGION_FILL_LAYER = 'regions-fill'
export const REGION_LINE_LAYER = 'regions-line'

/**
 * Region boxes as polygons.
 *
 * A bbox has to become an explicit closed ring: MapLibre will render an unclosed one, just
 * as a sliver rather than an error.
 */
export function regionsGeoJson(
  regions: RegionEntry[],
  states: Record<string, RegionState>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: regions.map(({ id, name, bbox: [west, south, east, north] }) => ({
      type: 'Feature',
      properties: { id, name, state: states[id] ?? 'not-installed' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ]],
      },
    })),
  }
}

/**
 * Adds the picker's own layers.
 *
 * These are chrome over the map rather than part of it, so they follow the route line's
 * rule: high chroma, because every stroke in both basemap palettes is C 15.4 or less and a
 * boundary that reads as map furniture is a boundary nobody taps.
 */
export function ensureRegionLayers(map: MapLibreMap): void {
  if (map.getSource(REGION_SOURCE)) return

  map.addSource(REGION_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })

  map.addLayer({
    id: REGION_FILL_LAYER,
    type: 'fill',
    source: REGION_SOURCE,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': [
        'match',
        ['get', 'state'],
        'current', REGION_COLOURS.current,
        'road-data-outdated', REGION_COLOURS.outdated,
        'map-outdated', REGION_COLOURS.outdated,
        REGION_COLOURS.available,
      ],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.45, 0.18],
    },
  })

  map.addLayer({
    id: REGION_LINE_LAYER,
    type: 'line',
    source: REGION_SOURCE,
    paint: {
      'line-color': [
        'match',
        ['get', 'state'],
        'current', REGION_COLOURS.current,
        'road-data-outdated', REGION_COLOURS.outdated,
        'map-outdated', REGION_COLOURS.outdated,
        REGION_COLOURS.available,
      ],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.5],
    },
  })
}

export function setRegionData(map: MapLibreMap, collection: GeoJSON.FeatureCollection): void {
  const source = map.getSource(REGION_SOURCE) as GeoJSONSource | undefined
  source?.setData(collection)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/setup/regionLayers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Check the fill filter rule holds**

Run: `cd web && npx vitest run src/map/style.test.ts`
Expected: PASS. `style.test.ts` asserts that every `fill` layer filters to `['==', ['geometry-type'], 'Polygon']`. If it scans layers built at runtime as well as the style, the region fill layer above already satisfies it; if it fails, fix the layer rather than the test.

- [ ] **Step 6: Commit**

```bash
git add web/src/setup/regionLayers.ts web/src/setup/regionLayers.test.ts
git commit -m "Setup: region outlines as map layers"
```

---

## Task 12: the region picker

**Files:**
- Create: `web/src/setup/RegionPicker.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/ride/ride.css`
- Delete: `web/src/setup/FirstRun.tsx`

**Interfaces:**
- Consumes: `MANIFEST_URL`, `assetUrl`, `parseManifest` (Task 6), `regionState`, `downloadPlan` (Task 7), `sharedEngine().downloadRegion / installedRegions` (Task 9), `basemap.showRemote` (Task 10), `regionsGeoJson`, `ensureRegionLayers`, `setRegionData`, `REGION_FILL_LAYER` (Task 11).
- Produces: `<RegionPicker basemap={...} onDone={() => void} />`, rendered by `App.tsx` when no region is installed.

`FirstRun.tsx` is the model for the structure and the copy register. Read it before starting; it is deleted at the end of this task.

- [ ] **Step 1: Write the picker**

Behaviour, in order:

1. On mount, call `loadManifest()` from Task 6. It handles the cache and reports `fresh`, which is passed straight to `regionState`. If it throws, the phone is offline and has never seen the mirror: show that message and a link to Setup for manual import. Never a blank screen.
2. Call `basemap.showRemote(assetUrl(manifest.picker.url))` so Britain draws while the rider reads.
3. `ensureRegionLayers(map)` and `setRegionData(map, regionsGeoJson(manifest.regions, states))`.
4. A tap on `REGION_FILL_LAYER` selects that region. `map.queryRenderedFeatures(e.point, { layers: [REGION_FILL_LAYER] })` gives the id. Set the feature state so the outline thickens.
5. The selected region opens a sheet: its name, `downloadPlan(...).bytes` as plain megabytes, and a Download button. Say the size in front of the button. Safari has no `NetworkInformation`, so there is no honest way to warn about mobile data and pretending otherwise is worse than saying nothing.
6. Download calls `sharedEngine().downloadRegion(region, manifest, Comlink.proxy(onProgress))` and renders `overallReceived / overallTotal` as a bar plus the current file's name in words ("the map", "the road data").
7. On success: `await basemap.refresh()`, `await basemap.show(`${region.id}.pmtiles`)`, then `onDone()`.
8. On failure: keep the sheet open with the error and a Retry button. A retry resumes rather than restarting, because the partial file and its hash are already recorded.

Copy rules: the words `.rd5`, `.pmtiles`, `segment` and `OPFS` do not appear anywhere on this screen. "The map" and "the road data" are the two things a rider is downloading.

- [ ] **Step 2: Wire it into the app**

In `web/src/App.tsx`, replace the `FirstRun` import and render. The gate changes from "no basemap or no tiles" to "no installed region", but must still respect a phone that got its data by manual import in an earlier build:

```typescript
  useEffect(() => {
    void (async () => {
      try {
        const [regions, archives, tiles] = await Promise.all([
          sharedEngine().installedRegions(),
          sharedEngine().installedBasemaps(),
          sharedEngine().installedTiles(),
        ])
        // A phone that imported files by hand before regions existed is set up, and must not
        // be sent back to the picker.
        setNeedsSetup(regions.length === 0 && (archives.length === 0 || tiles.length === 0))
      } catch {
        setNeedsSetup(true)
      }
    })()
  }, [])
```

- [ ] **Step 3: Style it**

Add `.picker` rules to `web/src/ride/ride.css` beside the existing `.firstrun` block, then delete the `.firstrun` rules along with the component. Requirements: the sheet uses the `--panel*` translucency tokens; the map fills the screen behind it; the download button is at least 44px tall; the layout uses `100dvh` rather than `inset: 0`, and the `(display-mode: standalone)` rule that sets `html, body { min-height: 100lvh }` must keep applying, or the bottom of the sheet will not paint in a home-screen app.

- [ ] **Step 4: Verify in the browser**

Run: `cd web && npm run build && npm run preview`

Then, in a private window with storage cleared:
1. The app opens on a map of Britain with region outlines. Expected: no download has started.
2. Tap a region. Expected: the sheet names it and states the size in MB.
3. Download it. Expected: a progress bar that reaches 100%, then the ride screen on that region's map.
4. Reload. Expected: straight to the ride screen, no picker.
5. In devtools, throttle to offline midway through a download, then back online and hit Retry. Expected: the transfer resumes rather than restarting from zero. Confirm in the Network panel that the request carries a `Range` header.

- [ ] **Step 5: Delete the old first-run screen**

```bash
git rm web/src/setup/FirstRun.tsx
```

Then check nothing still imports it: `cd web && npm run build` must succeed.

- [ ] **Step 6: Commit**

```bash
git add web/src/setup/RegionPicker.tsx web/src/App.tsx web/src/ride/ride.css
git commit -m "Setup: pick a region on a map instead of importing two files"
```

---

## Task 13: the rules, and the ride

**Files:**
- Modify: `CLAUDE.md`
- Modify: `HANDOFF.md`
- Modify: `web/src/engine/tileStore.ts` (header comment only)
- Create: `docs/phase-6-progress.md`

- [ ] **Step 1: Correct the import-only rule in `CLAUDE.md`**

The bullet currently reads "Tiles are import-only. The app never downloads routing data". Replace it with the rule as it now stands, keeping the part that is still true:

```markdown
- **Routing data comes from our mirror, never from brouter.de.** The app downloads regions
  from the bucket described in `web/tools/mirror/README.md`; a weekly cron on the VPS is the
  only thing that ever talks to brouter.de, at roughly eight conditional requests a week.
  Never fetch from brouter.de in the app: it sends no CORS header, so a browser could not
  anyway, and never route against its API. Manual `.rd5` and `.pmtiles` import stays as an
  escape hatch for a bucket outage and for testing custom extracts.
- **Imported data goes stale, and the mirror is what tells you.** Every object in the bucket
  is content-addressed, so an update is offered only when the bytes actually differ. A weekly
  upstream rebuild with identical bytes is not an update.
```

- [ ] **Step 2: Correct the header comment in `tileStore.ts`**

Its first paragraphs say the app deliberately does not download routing data. Rewrite them to describe the mirror, keep the paragraph about brouter.de sending no CORS header as the reason the app still never fetches from it directly, and keep the staleness paragraph, which is now handled by hashes rather than dates.

- [ ] **Step 3: Update `HANDOFF.md`**

Add Phase 6 to the status table, replace the three-step AirDrop instructions under "Deployment" with a sentence saying data now comes from the mirror and that manual import is the fallback, and note the five environment variables the VPS cron needs.

- [ ] **Step 4: Write `docs/phase-6-progress.md`**

Record what was measured rather than what was planned, following the other phase documents: the region sizes actually produced by `cut-basemaps.mjs`, the observed first-download time on a phone, anything the design got wrong, and the bucket's public URL.

- [ ] **Step 5: The acceptance test, on a real iPhone**

This is the only step that decides whether the phase is done. Desktop Safari and the Simulator both diverge from real devices on storage.

1. Deploy, then on a physical iPhone open the app and add it to the Home Screen.
2. Clear the site's storage first, so this is a true cold start.
3. Launch from the Home Screen. Expected: a map of Britain, streamed, with region outlines.
4. Tap your region and download it. Expected: a progress bar that completes, then the ride screen.
5. Force-quit the app. Enable airplane mode. Launch from the Home Screen again.
6. Plan a route and follow it. Expected: routing works with no network at all.

If step 6 reports `segment directory /segments4 does not exist`, `downloadRegion` is not calling `installedTiles()` at the end. That failure only appears on a cold start, never on a reload with warm state.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md HANDOFF.md web/src/engine/tileStore.ts docs/phase-6-progress.md
git commit -m "Phase 6: the mirror replaces manual import as the way in"
```

---

## Self-review notes

**Spec coverage.** Bucket layout, CORS and cache headers: Task 5. Manifest schema: Tasks 4 and 6. Weekly sync and the identical-bytes rule: Tasks 3 and 5. Monthly basemap cut: Task 5. Length-check integrity and resume: Task 8. Region list cut to a byte budget: Task 2. Streamed picker: Tasks 10 and 12. `installedTiles()` after download: Task 9. Shared segments: Tasks 7 and 9. Offline and quota behaviour: Task 12 step 1. Rule changes: Task 13.

**Deferred to Phase 7, as the spec says:** the Setup restructure into Regions, Preferences, About and Advanced; the Diagnostics gesture; deleting `TilesPanel`'s estimator and `build-catalogue`; the `.setup-header` colour token.

**Known rough edge.** Task 7 step 3 deliberately ships a broken `regionState` that step 4 corrects, because the hole is worth seeing: a region carries its basemap hash but not its segments' hashes, and the function cannot work without the manifest. If you would rather write it correctly the first time, use the step 4 signature and skip step 3's version.
