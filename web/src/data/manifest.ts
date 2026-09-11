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

/**
 * A segment name is a BRouter grid cell id (`W5_N55`), never anything else. Constraining the
 * shape isn't just validation: `segments[name] = ...` below assigns onto a plain object with a
 * caller-controlled key, and an unconstrained name of `__proto__` would set the object's
 * prototype instead of an own property. Requiring the grid shape closes that off structurally
 * rather than by special-casing the dangerous key.
 */
const SEGMENT_NAME = /^[EW]\d{1,3}_[NS]\d{1,2}$/

/**
 * A region id is a slug, for the same structural reason a segment name is a grid cell id: it
 * becomes a file path. `regionStore.basemapFileFor` turns it straight into
 * `/basemap/<id>.pmtiles`, so an id carrying a `/` or a `..` writes a region's basemap into
 * some other directory — `opfsVfs.normalise` resolves `..` within the OPFS root, so nothing
 * escapes origin storage, but the wrong directory is still the wrong directory. The manifest
 * is ours, so this is a data-authoring mistake rather than an attack; the mirror's own
 * `regions.json` tests already require this shape, and checking it here is what makes the two
 * agree where every other shape in the manifest is already checked.
 */
const REGION_ID = /^[a-z0-9-]+$/

function asset(
  value: unknown,
  where: string,
  options: { requireHash?: boolean } = {},
): { url: string; bytes: number; hash: string } {
  const requireHash = options.requireHash ?? true
  if (!isObject(value)) throw new Error(`${where}: expected an asset, got ${typeof value}`)
  const { url, bytes, hash } = value
  if (typeof url !== 'string' || url.length === 0) throw new Error(`${where}: missing url`)
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${where}: bytes is ${String(bytes)}`)
  }
  if (requireHash && (typeof hash !== 'string' || hash.length === 0)) {
    throw new Error(`${where}: missing hash`)
  }
  return { url, bytes, hash: typeof hash === 'string' ? hash : '' }
}

export function parseManifest(value: unknown): DataManifest {
  if (!isObject(value)) throw new Error('not a manifest: expected an object')
  if (value.version !== 1) throw new Error(`manifest version ${String(value.version)} is not supported`)
  if (!isObject(value.segments)) throw new Error('manifest has no segments')
  if (!Array.isArray(value.regions)) throw new Error('manifest has no regions')

  const segments: Record<string, SegmentEntry> = {}
  for (const [name, entry] of Object.entries(value.segments)) {
    if (!SEGMENT_NAME.test(name)) throw new Error(`segment name ${name} is not a valid grid cell id`)
    const { url, bytes, hash } = asset(entry, `segment ${name}`)
    const changed = isObject(entry) && typeof entry.changed === 'string' ? entry.changed : ''
    segments[name] = { url, bytes, hash, changed }
  }

  const regions = value.regions.map((raw): RegionEntry => {
    if (!isObject(raw)) throw new Error('region: expected an object')
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!REGION_ID.test(id)) {
      throw new Error(`region id ${JSON.stringify(id)} is not a slug of lowercase letters, digits and hyphens`)
    }
    if (typeof raw.name !== 'string') throw new Error(`${id}: no name`)
    if (!Array.isArray(raw.bbox) || raw.bbox.length !== 4 || raw.bbox.some((n) => typeof n !== 'number')) {
      throw new Error(`${id}: bbox must be four numbers`)
    }
    const basemap = asset(raw.basemap, id)
    const built = isObject(raw.basemap) && typeof raw.basemap.built === 'string' ? raw.basemap.built : ''
    if (!Array.isArray(raw.segments) || raw.segments.some((s) => typeof s !== 'string')) {
      throw new Error(`${id}: segments must be a list of names`)
    }
    // A region with no road data is not a region, it is a map. The mirror publishes exactly
    // this shape on purpose while bootstrapping — `tools/mirror/lib/bootstrap.mjs` carries a
    // region whose segments are not mirrored yet forward with an empty list, so that
    // `cut-basemaps` can publish at all on an empty bucket — and a phone that fetched that
    // manifest would price the region as basemap-only, download it, record it, and then read
    // `current` from `regionState` while BRouter had nothing to route on.
    //
    // Rejecting the whole manifest rather than dropping the region is deliberate: the state
    // is transient (the next `mirror:segments` run fills it in), and a phone that has a
    // cached copy keeps using it and reports every region as `unknown`, which is true. A
    // silently shortened region list would instead be a permanent-looking answer to a
    // temporary condition.
    if (raw.segments.length === 0) {
      throw new Error(`${id}: has no segments, so it has no road data — the mirror is mid-bootstrap`)
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

  // No hash: the picker archive is downloaded unconditionally, never compared for staleness
  // the way a region's segments and basemap are. It still needs the same "not a failed
  // upload" guarantee as everything else, so it goes through the same positive-bytes check.
  const picker = asset(value.picker, 'picker', { requireHash: false })

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
    // Caching is a best-effort side effect of a successful fetch, not part of what makes the
    // fetch succeed. iOS Safari in Private Browsing throws QuotaExceededError on every
    // setItem call, and a manifest we just fetched and validated is not stale just because we
    // failed to save a copy of it — so a write failure here must never fall into the catch
    // below, which means "the fetch failed".
    try {
      localStorage.setItem(CACHE_KEY, text)
    } catch {
      // Nothing to do: the fetched manifest is still good, we just won't have a cached
      // fallback next time we're offline.
    }
    return { manifest, fresh: true }
  } catch (error) {
    if (!cached) {
      throw new Error(
        `could not reach the mirror and there is no saved copy: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    try {
      return { manifest: parseManifest(JSON.parse(cached)), fresh: false }
    } catch (cacheError) {
      // The cached copy itself is corrupt or from an old, incompatible schema. Discard it —
      // otherwise every future call fails the same way until someone clears storage by hand —
      // and say plainly that it was the cache at fault, not the network.
      localStorage.removeItem(CACHE_KEY)
      throw new Error(
        `the saved copy was unreadable and has been discarded: ${
          cacheError instanceof Error ? cacheError.message : String(cacheError)
        }`,
      )
    }
  }
}
