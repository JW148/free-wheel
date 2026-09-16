import { haversineM } from '../ride/geo'

/**
 * Searching for a place, with the network off.
 *
 * ## There is no geocoder, and there still is not going to be one
 *
 * The rule in `CLAUDE.md` says reverse geocoding is a network service and the whole app is
 * built on not needing one. That rule is unchanged. This is not a geocoder — nothing is sent
 * anywhere and nothing is looked up. It is an index of the names *already on the phone*: each
 * region's basemap archive carries them on its places, its roads, its water and its POIs, and
 * for an Edinburgh-sized extract that is 1,715 settlements and neighbourhoods, 11,807 named
 * points of interest and 20,582 named roads, all of it downloaded weeks ago and sitting in
 * OPFS being drawn as labels.
 *
 * So the app was already shipping the data and only ever using it to write words on the map.
 * Reading it back is the difference between "tap the map somewhere near your house" and
 * "type your street".
 *
 * Postcodes are the one thing genuinely absent: nothing in the Protomaps schema holds them, and
 * they would mean shipping Code-Point Open alongside every archive. Place and street names are
 * what a rider means on a map anyway.
 *
 * ## Why a packed index rather than a query over the archive
 *
 * Scanning the archive's deepest zoom is what *builds* this — 2,760 tiles and 285 ms on a
 * laptop for Edinburgh — and doing that per keystroke is obviously impossible. So it is done
 * once per archive, in the engine Worker where the OPFS handles live, and the result is kept in
 * IndexedDB: about 0.9 MB for a region, against the 34 MB archive it came from.
 *
 * ## Why one enormous string and not a trie
 *
 * The whole index is `'\n' + name + '\n' + name + …`, folded to a searchable form. A search is
 * then `String.prototype.indexOf` in a loop over ~600 KB, which is a native scan and faster
 * than anything that could be built on top of it in JavaScript — and it is a few dozen lines
 * instead of a data structure with its own failure modes. A binary search over the start
 * offsets turns a match position back into an entry.
 *
 * `\n` is the delimiter and folding removes it from names, so a match can never straddle two
 * entries.
 */

export type PlaceCategory = 'place' | 'road' | 'poi' | 'water'

/** One searchable thing: a name, where it is, and what sort of thing it is. */
export interface PlaceEntry {
  name: string
  category: PlaceCategory
  /** Protomaps' own `kind`, e.g. `locality`, `minor_road`, `pub`. */
  kind: string
  lon: number
  lat: number
}

/**
 * An index as it is stored and shipped between threads.
 *
 * Parallel arrays rather than an array of objects, because 35,000 objects is 35,000 allocations
 * on a phone that is also holding a Wasm routing engine and a WebGL map. `kindTable` holds
 * `category:kind` pairs so the category needs no second array — it is known at build time from
 * which source layer the feature came out of, and it never has to be inferred.
 *
 * `Float32Array` for the coordinates: its worst case over Britain is about 0.7 m of latitude,
 * which is a tenth of what the GPS fix beside it knows.
 */
export interface PlaceIndex {
  /** The archive file this was read out of, e.g. `central-scotland.pmtiles`. */
  archive: string
  builtAt: number
  /** Size of the archive when this was built, so a re-download rebuilds it. */
  sourceBytes: number
  /** Display names, `\n`-joined. */
  names: string
  /** `category:kind`, e.g. `place:locality`. */
  kindTable: string[]
  kinds: Uint16Array
  lons: Float32Array
  lats: Float32Array
}

/** An index with its searchable form built. Held in memory; never stored. */
export interface LoadedIndex {
  source: PlaceIndex
  /** Folded names, `\n`-delimited, with a leading and a trailing `\n`. */
  hay: string
  /** Where each entry's folded name starts in {@link hay}. */
  starts: Int32Array
  /** Where each entry's *display* name starts in `source.names`. */
  labels: Int32Array
  count: number
}

export interface SearchHit {
  name: string
  category: PlaceCategory
  kind: string
  lon: number
  lat: number
  /** The archive it came from, which is also what says it is routable. */
  archive: string
  /** Metres from the point the search was made near, or `null` when there was none. */
  distanceM: number | null
  score: number
}

/**
 * The searchable form of a name.
 *
 * Case and accents go, because a rider typing on a phone keyboard types neither. Punctuation
 * becomes a space rather than vanishing, so `St. Andrew's` and `Hay-on-Wye` both fold to
 * something a plain typist produces — and so that `-on-` counts as a word boundary, which is
 * what makes `wye` a word match rather than a substring buried in the middle.
 *
 * The apostrophe is the exception and is simply deleted: `Andrew's` has to fold to `andrews`,
 * not `andrew s`, or nobody ever finds it.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Packs entries into the form that is stored, shipped and searched. */
export function packIndex(
  archive: string,
  sourceBytes: number,
  entries: PlaceEntry[],
  at = Date.now(),
): PlaceIndex {
  const kindTable: string[] = []
  const kindIds = new Map<string, number>()
  const kinds = new Uint16Array(entries.length)
  const lons = new Float32Array(entries.length)
  const lats = new Float32Array(entries.length)
  const names: string[] = []

  entries.forEach((entry, i) => {
    const key = `${entry.category}:${entry.kind}`
    let id = kindIds.get(key)
    if (id === undefined) {
      id = kindTable.length
      kindTable.push(key)
      kindIds.set(key, id)
    }
    kinds[i] = id
    lons[i] = entry.lon
    lats[i] = entry.lat
    // A newline in a name would split one entry into two, and the second would have no
    // coordinates. Protomaps has never produced one; this is cheaper than finding out.
    names.push(entry.name.replace(/[\n\r]+/g, ' '))
  })

  return { archive, builtAt: at, sourceBytes, names: names.join('\n'), kindTable, kinds, lons, lats }
}

/** Builds the searchable haystack. Costs one pass; done once per index per session. */
export function loadIndex(source: PlaceIndex): LoadedIndex {
  const display = source.names.length === 0 ? [] : source.names.split('\n')
  const count = Math.min(display.length, source.kinds.length)

  const starts = new Int32Array(count)
  const labels = new Int32Array(count)
  let hay = '\n'
  let labelAt = 0
  for (let i = 0; i < count; i++) {
    starts[i] = hay.length
    labels[i] = labelAt
    labelAt += display[i].length + 1
    hay += `${fold(display[i])}\n`
  }

  return { source, hay, starts, labels, count }
}

/** How much a match is worth, before the distance to it is taken off. */
const MATCH_SCORE = { exact: 100, prefix: 72, word: 54, substring: 26 }

/**
 * What sort of thing it is, as a tiebreak between equally good matches of the same name.
 *
 * A settlement beats a street beats a farm gate, because that is the order in which a rider
 * means them — somebody typing "Portobello" means the place, not the fifth footpath in it.
 */
const CATEGORY_SCORE: Record<PlaceCategory, number> = { place: 10, poi: 6, road: 5, water: 3 }

/**
 * Kinds that are named *areas* rather than anywhere you would ride to.
 *
 * Protomaps files these under `pois` alongside pubs and stations, and they are the bulk of the
 * layer — 1,249 farmyards in the Edinburgh extract against 118 pubs. They are still worth
 * having (a named wood is a landmark) but they must never sit above the thing with the same
 * name that a rider actually meant.
 */
const DULL_KINDS = new Set([
  'farmyard',
  'farmland',
  'residential',
  'industrial',
  'commercial',
  'construction',
  'retail',
  'grass',
  'garden',
  'wood',
  'forest',
  'scrub',
  'meadow',
  'orchard',
  'allotments',
  'brownfield',
  'quarry',
  'military',
  'pitch',
  'bare_rock',
])
const DULL_PENALTY = 7

/**
 * How much being far away costs.
 *
 * Logarithmic, not linear. The difference between 1 km and 5 km is most of what a rider means
 * by "near me"; the difference between 60 km and 64 km is nothing at all, and a linear penalty
 * spends its whole range saying so. Tuned so a prefix match 40 km off still beats a buried
 * substring match down the road, and two equally good matches sort by which is nearer.
 */
const DISTANCE_WEIGHT = 12
const DISTANCE_SOFTENER_KM = 3

/**
 * How many raw matches are ranked.
 *
 * A two-letter query matches tens of thousands of names and ranking all of them is work whose
 * only possible outcome is the same first ten. The cap is high enough that it is never reached
 * by a query anybody typed on purpose.
 */
const MAX_MATCHES = 4000

/**
 * Everything in one index that matches, best first.
 *
 * Whole-word and prefix matches are what a rider is nearly always after, but a plain substring
 * still counts — "brig" should find "Cramond Brig" and it does, two ranks down.
 */
export function searchIndex(
  loaded: LoadedIndex,
  query: string,
  near: { lon: number; lat: number } | null,
  limit = 25,
): SearchHit[] {
  const needle = fold(query)
  if (needle.length === 0) return []

  const hits: SearchHit[] = []
  let at = loaded.hay.indexOf(needle)
  let scanned = 0
  while (at !== -1 && scanned < MAX_MATCHES) {
    scanned++
    const i = entryAt(loaded.starts, at)
    if (i >= 0) {
      const start = loaded.starts[i]
      const end = loaded.hay.indexOf('\n', start)
      const quality =
        at === start
          ? end - start === needle.length
            ? MATCH_SCORE.exact
            : MATCH_SCORE.prefix
          : loaded.hay[at - 1] === ' '
            ? MATCH_SCORE.word
            : MATCH_SCORE.substring

      const [category, kind] = splitKind(loaded.source.kindTable[loaded.source.kinds[i]])
      const lon = loaded.source.lons[i]
      const lat = loaded.source.lats[i]
      const distanceM = near ? haversineM([near.lon, near.lat], [lon, lat]) : null

      hits.push({
        name: nameAt(loaded, i),
        category,
        kind,
        lon,
        lat,
        archive: loaded.source.archive,
        distanceM,
        score:
          quality +
          CATEGORY_SCORE[category] -
          (DULL_KINDS.has(kind) ? DULL_PENALTY : 0) -
          (distanceM === null
            ? 0
            : DISTANCE_WEIGHT *
              Math.log10(1 + distanceM / 1000 / DISTANCE_SOFTENER_KM)),
      })
      // Past the end of this name: a second match inside one name is still one result.
      at = end
    }
    at = loaded.hay.indexOf(needle, at + 1)
  }

  return rank(hits, limit)
}

/** The display name of an entry, sliced out of the joined string. */
export function nameAt(loaded: LoadedIndex, i: number): string {
  const from = loaded.labels[i]
  const to = loaded.source.names.indexOf('\n', from)
  return to === -1 ? loaded.source.names.slice(from) : loaded.source.names.slice(from, to)
}

/**
 * Merges the hits from every installed archive.
 *
 * Deduplication is the reason this exists rather than a concat and a sort, and there are two
 * sources of duplicates rather than one.
 *
 * The published regions **overlap** — deliberately and generously — so Edinburgh is in Central
 * Scotland's archive and in Southern Scotland's, and a rider with both installed would otherwise
 * see every result twice.
 *
 * And one place is often filed twice inside a *single* archive. Portobello is a `places`
 * neighbourhood and a `pois` place 400 m apart, which produced two rows called Portobello with
 * two different words under them and no way for a rider to tell which they wanted. So the match
 * is on the **name and the position only**, and the category is deliberately not part of it: the
 * better-scoring one wins and the other is the same answer said twice.
 */
const SAME_PLACE_M = 2_000

export function mergeHits(lists: SearchHit[][], limit = 25): SearchHit[] {
  const kept: SearchHit[] = []
  for (const hit of rank(lists.flat(), Number.MAX_SAFE_INTEGER)) {
    const duplicate = kept.some(
      (seen) =>
        seen.name === hit.name &&
        haversineM([seen.lon, seen.lat], [hit.lon, hit.lat]) < SAME_PLACE_M,
    )
    if (!duplicate) kept.push(hit)
    if (kept.length >= limit) break
  }
  return kept
}

function rank(hits: SearchHit[], limit: number): SearchHit[] {
  return hits
    .sort((a, b) => b.score - a.score || (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .slice(0, limit)
}

function splitKind(entry: string | undefined): [PlaceCategory, string] {
  const colon = entry ? entry.indexOf(':') : -1
  if (!entry || colon === -1) return ['poi', entry ?? '']
  return [entry.slice(0, colon) as PlaceCategory, entry.slice(colon + 1)]
}

/** Binary search: which entry contains a position in the haystack. */
function entryAt(starts: Int32Array, at: number): number {
  let low = 0
  let high = starts.length - 1
  if (high < 0 || at < starts[0]) return -1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= at) low = mid
    else high = mid - 1
  }
  return low
}
