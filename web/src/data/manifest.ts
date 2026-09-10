/**
 * The one document the app fetches from the mirror, and the types the rest of the data layer
 * speaks in.
 *
 * Parsing is strict on purpose. A static host answers a missing file with an HTML error page
 * and a 200 in some configurations, and a half-read manifest would show a rider regions that
 * cannot be downloaded. Failing loudly here is the difference between "the mirror is down"
 * and a mystery.
 */

import { MANIFEST_URL } from './origin'

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
