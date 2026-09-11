/**
 * Re-cuts the region basemaps and the picker's backdrop. Run by hand — see README.md.
 *
 * The expensive half of the mirror, and the one to run rarely: a Protomaps daily build changes
 * an extract's bytes almost every time, so hashing does not damp basemap churn the way it damps
 * segments. An 86 MB re-download is not worth offering because a cafe moved.
 *
 * Needs the `pmtiles` CLI on PATH and a recent dated build: the dated archives expire.
 *
 * No retry around the network calls or `pmtiles extract` below: a transient failure here
 * fails the whole run loudly rather than publishing a partial manifest, and you run it again.
 * That is deliberate, not an oversight — a run that fails loud in front of the person who
 * started it is easier to reason about than one that silently retries into a half-published
 * state.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashOf } from './lib/decide.mjs'
import { buildBootstrapManifest } from './lib/bootstrap.mjs'
import { assertPublishable } from './lib/manifest.mjs'
import { IMMUTABLE, MANIFEST_CACHE, listKeys, putObject, readJson } from './s3.mjs'

const build = process.argv[2]
if (!build) {
  throw new Error('usage: node cut-basemaps.mjs <YYYYMMDD>   (a recent build.protomaps.com date)')
}
const SOURCE = `https://build.protomaps.com/${build}.pmtiles`
const UK_BBOX = [-8.7, 49.8, 2.0, 61.0]

const regions = JSON.parse(readFileSync(new URL('regions.json', import.meta.url), 'utf8'))
const previous = (await readJson('manifest.json')) ?? { segments: {}, regions: [] }
// Each extracted .pmtiles archive is tens to ~180 MB (Task 2's measurements) and there are 15
// of them (14 regions plus the UK overview) every run. Cleaned up in the `finally` below so a
// run doesn't leave up to a gigabyte behind in your temp directory — this was left dangling in
// the plan's own reference code.
const work = mkdtempSync(join(tmpdir(), 'free-wheel-cut-'))

try {
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

  // buildBootstrapManifest (web/tools/mirror/lib/bootstrap.mjs) handles the case where a
  // region's segments have never been synced — only possible before mirror:segments has ever
  // run, or right after a region is added to regions.json. In the steady state it is a pure
  // pass-through to buildManifest; see its own tests for both cases.
  const { manifest, pending } = buildBootstrapManifest({
    regions: withBasemaps,
    segments: previous.segments ?? {},
    picker,
    generated: new Date().toISOString(),
  })
  for (const id of pending) {
    console.log(`${id}: no segments mirrored yet — run npm run mirror:segments next`)
  }

  assertPublishable(manifest, await listKeys(''))
  await putObject('manifest.json', JSON.stringify(manifest, null, 2), {
    contentType: 'application/json',
    cacheControl: MANIFEST_CACHE,
  })
  console.log(`manifest published, ${manifest.regions.length} regions`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
