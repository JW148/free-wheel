/**
 * Mirrors the BRouter segments Britain needs, weekly.
 *
 * Roughly eight conditional requests to brouter.de. That is the entire load this project
 * puts on it, and it replaces one full download per new rider.
 *
 * Must run after `cut-basemaps.mjs` has published at least one basemap for every region in
 * `regions.json` — this script carries basemap entries forward from the current manifest
 * rather than cutting them itself, and refuses to publish a region it has no basemap for.
 *
 * No retry around the fetches or the upload below: a transient failure fails the whole run
 * loudly, brouter.de is untouched by it, and the job simply runs again next week. That is
 * deliberate — a partial publish is worse than a skipped week.
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
