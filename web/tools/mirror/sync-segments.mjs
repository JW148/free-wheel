/**
 * Mirrors the BRouter segments Britain needs. Run by hand — see README.md.
 *
 * Roughly eight conditional requests to brouter.de. That is the entire load this project
 * puts on it, and it replaces one full download per new rider.
 *
 * Must run after `cut-basemaps.mjs` has published at least one basemap for every region in
 * `regions.json` — this script carries basemap entries forward from the current manifest
 * rather than cutting them itself, and refuses to publish a region it has no basemap for.
 *
 * No retry around the fetches or the upload below: a transient failure fails the whole run
 * loudly, brouter.de is untouched by it, and you run it again. That is deliberate — a partial
 * publish is worse than a skipped run.
 */
import { readFileSync } from 'node:fs'
import { segmentsForBbox } from './lib/geometry.mjs'
import { decideSegmentAction, hashOf } from './lib/decide.mjs'
import { buildManifest, assertPublishable } from './lib/manifest.mjs'
import { carryForwardBasemaps } from './lib/bootstrap.mjs'
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

// Region basemaps are cut by `cut-basemaps.mjs`; carry forward whatever it last published.
//
// A region with none yet is left out of this manifest rather than failing the run. It used to
// throw, which meant that adding a region to `regions.json` stopped every routing-data update
// until `cut-basemaps` next ran — which, unscheduled, may be months: the segments above had
// already been fetched and published, and then nothing was written to say so. Its segments are
// mirrored above regardless — `wanted` is computed from every region in `regions.json` — so the
// next basemap run finds them waiting and publishes the region complete on its first pass.
const { regions: withBasemaps, missingBasemap } = carryForwardBasemaps(regions, previous.regions)
for (const id of missingBasemap) {
  console.log(`${id}: no basemap yet — left out of this manifest. Run: npm run mirror:basemaps`)
}

// Every region unready is the brand-new-bucket case, and there is nothing useful to publish:
// a manifest with no regions would replace whatever is there with an empty picker list.
if (withBasemaps.length === 0) {
  throw new Error('no region has a basemap yet — run `npm run mirror:basemaps` first')
}

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
