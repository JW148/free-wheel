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
import { segmentsForBbox } from './lib/geometry.mjs'
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

// buildManifest refuses to publish a region whose segments are not already in the bucket
// (deliberately — see lib/manifest.mjs). That is right for the common case, where the
// weekly sync has already run and every region's segments are known. It is wrong for a
// region this script has just cut for the first time: on a brand new bucket, or the moment
// a region is added to regions.json, no segments exist for it yet, and this script has no
// way to fetch them — that is sync-segments.mjs's job, which must run next.
//
// So: hand the regions that are already fully covered to buildManifest unchanged, and carry
// the rest forward by hand with an empty segment list. The very next `npm run mirror:segments`
// fills them in and republishes a complete manifest; nothing here downgrades a region that
// was already complete.
const ready = withBasemaps.filter((region) =>
  segmentsForBbox(region.bbox).every((name) => previous.segments?.[name]))

const built = buildManifest({
  regions: ready,
  segments: previous.segments ?? {},
  picker,
  generated: new Date().toISOString(),
})
const byId = new Map(built.regions.map((region) => [region.id, region]))

// Reassemble in regions.json's own order rather than buildManifest's (ready-only) order, so
// a not-yet-synced region doesn't jump to the end of the picker's list.
const manifest = {
  ...built,
  regions: withBasemaps.map((region) => {
    const done = byId.get(region.id)
    if (done) return done
    console.log(`${region.id}: no segments mirrored yet — run npm run mirror:segments next`)
    return { id: region.id, name: region.name, bbox: region.bbox, basemap: region.basemap, segments: [] }
  }),
}

assertPublishable(manifest, await listKeys(''))
await putObject('manifest.json', JSON.stringify(manifest, null, 2), {
  contentType: 'application/json',
  cacheControl: MANIFEST_CACHE,
})
console.log(`manifest published, ${manifest.regions.length} regions`)
