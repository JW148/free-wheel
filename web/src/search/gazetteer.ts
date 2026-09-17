import { haversineM } from '../ride/geo'
import { fold } from './placeIndex'

/**
 * Every British town worth naming, and nothing else.
 *
 * ## Why an app that indexes its own maps also ships a list of towns
 *
 * Because the most confusing moment in an offline search is the one where it works perfectly.
 * A rider types "Aberystwyth", has Central Scotland downloaded and nothing else, and gets no
 * results — which is exactly what they would get for a misspelling, for a made-up name, and for
 * a search that is simply broken. Three very different situations, one blank screen.
 *
 * 48 kB of town names fixes all three at once: the app can say *Aberystwyth is in Mid and West
 * Wales*, put it on the map, and offer the download that would make it routable. That is the
 * same move `explainRoutingFailure` makes when BRouter cannot find a `.rd5` — name the thing to
 * fetch, and a dead end becomes a task.
 *
 * ## It is not routable and must never look it
 *
 * A gazetteer hit is a name and a coordinate. There is no road data behind it and no basemap to
 * draw it on, so it can be *reported* and never *chosen*. Everything here returns a type the
 * search screen cannot mistake for a `SearchHit`.
 *
 * ## Built by hand, shipped as an asset
 *
 * `tools/build-gazetteer.mjs`, from a Britain-wide z10 extract, committed like the engine and
 * the profiles. `json` is in the service worker's `globPatterns`, so it is there in airplane
 * mode — which is the only mode this matters in.
 */

export interface GazetteerPlace {
  name: string
  lon: number
  lat: number
}

interface Packed {
  v: number
  builtAt: string
  names: string
  lon: number[]
  lat: number[]
}

/** Coordinates are stored as hundred-thousandths of a degree. Must match the build tool. */
const SCALE = 1e5

let loading: Promise<Loaded | null> | null = null

interface Loaded {
  names: string[]
  folded: string[]
  lon: number[]
  lat: number[]
}

/**
 * Loads the gazetteer, once, and never twice.
 *
 * Returns `null` rather than throwing when it cannot be fetched. It is a courtesy: the search
 * works without it, and a rider who is offline on a phone whose service worker never precached
 * the asset should get "nothing found" rather than an error about a JSON file.
 */
export function loadGazetteer(fetcher: typeof fetch = fetch): Promise<Loaded | null> {
  return (loading ??= (async () => {
    try {
      const response = await fetcher('/gazetteer.json')
      if (!response.ok) return null
      const packed = (await response.json()) as Packed
      const names = packed.names.length === 0 ? [] : packed.names.split('\n')
      return {
        names,
        folded: names.map(fold),
        lon: packed.lon.map((v) => v / SCALE),
        lat: packed.lat.map((v) => v / SCALE),
      }
    } catch {
      return null
    }
  })())
}

/** Only for tests: the module cache is a module-level promise by design. */
export function resetGazetteer(): void {
  loading = null
}

/**
 * Towns matching a query, nearest first among equally good matches.
 *
 * Far simpler than `searchIndex`, and on purpose. This list is 1,822 entries rather than 35,000,
 * every one of them a settlement, so there are no categories to weigh and no kinds to demote —
 * a plain scan with a prefix-beats-substring rule is both enough and easier to be sure of.
 */
export function searchGazetteer(
  loaded: Loaded | null,
  query: string,
  near: { lon: number; lat: number } | null,
  limit = 6,
): GazetteerPlace[] {
  if (!loaded) return []
  const needle = fold(query)
  if (needle.length === 0) return []

  const scored: { place: GazetteerPlace; score: number }[] = []
  for (let i = 0; i < loaded.folded.length; i++) {
    const name = loaded.folded[i]
    const at = name.indexOf(needle)
    if (at === -1) continue
    const place = { name: loaded.names[i], lon: loaded.lon[i], lat: loaded.lat[i] }
    const quality =
      at === 0 ? (name.length === needle.length ? 100 : 70) : name[at - 1] === ' ' ? 50 : 25
    const away = near ? haversineM([near.lon, near.lat], [place.lon, place.lat]) / 1000 : 0
    scored.push({ place, score: quality - 6 * Math.log10(1 + away / 20) })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.place)
}
