import type { ParsedRoute, WayTagsAt } from './gpx'
import type { RouteGeometry } from './progress'

/**
 * What the road under the rider is made of, in the rider's words rather than the schema's.
 *
 * ## Where this comes from, and why it is not the basemap
 *
 * Every `.rd5` routing tile encodes its ways against `lookups.dat`, a fixed tag vocabulary,
 * and that vocabulary carries `highway`, `surface`, `smoothness`, `tracktype` and the four
 * cycle-route relations `route_bicycle_icn` / `ncn` / `rcn` / `lcn`. BRouter decodes them onto
 * every segment of every route it computes, and mode 9 writes them out. So this is data the
 * phone already had, from the file it was already routing against.
 *
 * It is worth being precise about the last of those, because `docs/phase-5-progress.md`
 * concluded that cycle network data is absent and was right — about the **basemap**. Protomaps
 * ships no `route=bicycle` relations at all. The routing tiles are a second dataset on the same
 * phone and they know network *membership*. Not the number: this can say "6.2 km on the
 * National Cycle Network" and can never say "NCN 1".
 *
 * ## Why a table
 *
 * The same argument `search/kinds.ts` makes about place kinds. `unclassified` is not "not
 * classified", `tracktype=grade3` means nothing to anybody, and a rider does not want to be
 * told they are on a `highway=living_street`. The vocabulary is wide and shallow, so it
 * collapses into a handful of words, and anything the table has never heard of falls back
 * rather than appearing raw.
 *
 * ## Why the fallbacks lean the way they do
 *
 * Two of them are asymmetric on purpose, and both asymmetries point the same way: **never
 * invent a warning**.
 *
 * An untagged surface is `unknown`, not `paved`. The map marks unpaved stretches with a dash,
 * and guessing here would draw that dash over a road nobody has measured — a claim about the
 * world made out of a gap in OpenStreetMap. `unknown` earns a row in the table, where a rider
 * can see that a tenth of the route is untagged and take it as a fact about the map.
 *
 * A `highway` value the table has never seen is `road`, never `main`. The main-road mark is
 * supposed to mean something the first time it is seen, and a schema addition that quietly
 * started painting caution stripes would spend that meaning.
 */

/** Ordered best to worst, which is the order the strip and the table are read in. */
export const ROAD_CLASSES = ['cyclepath', 'path', 'road', 'main'] as const
export type RoadClass = (typeof ROAD_CLASSES)[number]

export const SURFACE_CLASSES = ['paved', 'rough', 'loose', 'unknown'] as const
export type SurfaceClass = (typeof SURFACE_CLASSES)[number]

/** A stretch of route over which the tags do not change. */
export interface WayRun {
  fromM: number
  toM: number
  /** Everything BRouter decoded, so a later question can be asked without re-routing. */
  tags: Record<string, string>
  road: RoadClass
  surface: SurfaceClass
}

/**
 * The strip's colours, and why they are allowed to be colours at all.
 *
 * `gradeScale.ts` records the rule: these are chrome colours on a panel we control, so the
 * C <= 15.4 stroke ceiling that governs the basemap does not apply. That ceiling exists to stop
 * a route *line* being mistaken for a road, and nothing on a panel is on the map.
 *
 * What does apply is the same contrast window the gradient bands live in, and it is narrow. A
 * band has to clear 3:1 against `#ffffff` and against `#11212d` at once, which confines every
 * one to a relative luminance of roughly 0.14 to 0.30 — about 2:1 wide. Four classes cannot be
 * separated by lightness inside that, so they separate by hue at a held lightness. Three of
 * these sit at L* 45.5 to 45.9 and the fourth at 45.9, which is what makes the strip read as
 * one object rather than as one pale cell and three dark ones.
 *
 * Found by sweeping the RGB cube rather than by picking. Measured:
 *
 * - contrast 3.11 to 3.18 on `#11212d`, 5.20 to 5.28 on white
 * - worst pair among these four: ΔE 27.4, `path` against `road`
 * - worst against the six gradient bands: **ΔE 13.1**, `main` against `brutal`
 * - worst against the route colours: ΔE 12.0, `main` against `mtb`
 *
 * That 13.1 is below the 15 this started out wanting, and it is deliberate. The warm arc at
 * this luminance is already occupied by `very steep`, `brutal`, `mtb` and `recorded`, and a
 * red clearing 15 from all of them does not exist — the search returns a dusty rose at L* 60.6,
 * 15 points lighter than its neighbours, which is a pale outlier rather than a warning. The
 * confusion being risked is between a 10 px strip cell and an area chart's fill, two different
 * objects an inch apart that are never adjacent and never mean the same thing, and the two
 * bands it is nearest are both "be careful" like the cell itself. `chrome.test.ts` holds all
 * of these at the numbers above, so the trade stays visible rather than becoming folklore.
 */
export const ROAD_COLOURS: Record<RoadClass, string> = {
  cyclepath: '#007b60',
  path: '#7e694b',
  road: '#5d6c8a',
  main: '#d80050',
}

export const ROAD_LABELS: Record<RoadClass, string> = {
  cyclepath: 'Cycle path',
  path: 'Path or track',
  road: 'Minor road',
  main: 'Main road',
}

export const SURFACE_LABELS: Record<SurfaceClass, string> = {
  paved: 'Paved',
  rough: 'Cobbles or setts',
  loose: 'Unpaved',
  unknown: 'Not recorded',
}

const PAVED = new Set([
  'asphalt',
  'paved',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'cement',
  'chipseal',
  'paving_stones',
  'paving_stones:30',
  'paving_stones:20',
  'metal',
  'wood',
  'bricks',
  'brick',
])

const ROUGH = new Set([
  'sett',
  'cobblestone',
  'cobblestone:flattened',
  'unhewn_cobblestone',
  'grass_paver',
  'pebblestone',
])

const LOOSE = new Set([
  'unpaved',
  'unpaved_minor',
  'gravel',
  'fine_gravel',
  'compacted',
  'ground',
  'soil',
  'dirt',
  'dirt/sand',
  'earth',
  'sand',
  'grass',
  'artificial_turf',
  'mud',
  'clay',
  'rock',
  'rocks',
  'rocky',
  'stone',
])

/**
 * The surface class of a way.
 *
 * `compacted` is deliberately `loose` rather than `paved`. It is a rideable bound gravel and
 * plenty of tourers would not think twice, but it is not tarmac, and the rider who cares about
 * this distinction is the one on 25 mm tyres who wants to know before they get there.
 */
export function classifySurface(tags: Record<string, string>): SurfaceClass {
  const surface = tags.surface
  if (surface) {
    if (PAVED.has(surface)) return 'paved'
    if (ROUGH.has(surface)) return 'rough'
    if (LOOSE.has(surface)) return 'loose'
    return 'unknown'
  }

  // Only where `surface` said nothing. A track tagged both ways means somebody surveyed the
  // surface itself, and that beats a grading of the track as a whole.
  const tracktype = tags.tracktype
  if (tracktype) return tracktype === 'grade1' ? 'paved' : 'loose'

  return 'unknown'
}

const PATHS = new Set([
  'path',
  'track',
  'bridleway',
  'footway',
  'steps',
  'pedestrian',
  'corridor',
  'platform',
])

const MAIN = new Set([
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'trunk',
  'trunk_link',
  'motorway',
  'motorway_link',
])

export function classifyRoad(tags: Record<string, string>): RoadClass {
  const highway = tags.highway
  if (highway === 'cycleway') return 'cyclepath'
  if (highway && PATHS.has(highway)) return 'path'
  if (highway && MAIN.has(highway)) return 'main'
  return 'road'
}

const runCache = new WeakMap<ParsedRoute, WayRun[] | null>()

/**
 * The route cut into stretches of constant tags, measured in metres along it.
 *
 * Measured against the geometry the rest of the app measures against, rather than against
 * BRouter's own `track-length`. The two differ by a few metres over tens of kilometres —
 * `cumulativeM` is a sum of haversines over the track points, `track-length` is BRouter's —
 * and this has to agree with the elevation profile's x-axis and with `snapToRoute`, not with
 * the summary line. So the totals in the table are the route as drawn.
 *
 * Cached per route the way `routeGeometry` is, and for the same reason: the sheet, the map and
 * the riding screen all ask for this, and a 76 km route is several hundred runs.
 *
 * **The first run starts at 0**, not at the first `<brouter:way>`. BRouter's first entry lands
 * on the second track point, because the first is the snap from the tapped position onto the
 * network, and leaving those few metres unattributed would put a gap in the strip at the one
 * end the rider is looking at. The runs tile the route exactly, which is what lets the table
 * claim to total it.
 */
export function wayRuns(route: ParsedRoute, geometry: RouteGeometry): WayRun[] | null {
  const cached = runCache.get(route)
  if (cached !== undefined) return cached

  const built = buildRuns(route.ways, geometry)
  runCache.set(route, built)
  return built
}

function buildRuns(ways: WayTagsAt[] | undefined, geometry: RouteGeometry): WayRun[] | null {
  if (!ways || ways.length === 0) return null

  const { cumulativeM, totalM } = geometry
  const at = (index: number) => cumulativeM[Math.min(index, cumulativeM.length - 1)]

  const runs: WayRun[] = []
  for (let i = 0; i < ways.length; i++) {
    const fromM = i === 0 ? 0 : at(ways[i].index)
    const toM = i === ways.length - 1 ? totalM : at(ways[i + 1].index)
    /*
     * A tag change on a point the previous run already reached — two ways meeting at a node
     * with no distance between them. Nothing to draw and nothing to measure.
     *
     * Dropping it cannot open a gap, which is the property the table depends on. Way indices
     * are non-decreasing and `at` is monotonic, so `toM <= fromM` forces `toM === fromM`: the
     * run being dropped has zero length, and its neighbours already meet where it was. There
     * was a repair pass here closing gaps this cannot produce.
     */
    if (toM <= fromM) continue
    runs.push({
      fromM,
      toM,
      tags: ways[i].tags,
      road: classifyRoad(ways[i].tags),
      surface: classifySurface(ways[i].tags),
    })
  }

  return runs.length > 0 ? runs : null
}

export interface BreakdownRow {
  /**
   * The class this row totals.
   *
   * Carried as well as the label so the road table can show each class's colour beside it.
   * That is what makes the table the strip's legend: four colours above with no key is a
   * puzzle, and a separate legend row would be a third thing saying what two already say.
   */
  key: RoadClass | SurfaceClass
  label: string
  metres: number
}

export interface Breakdown {
  road: BreakdownRow[]
  surface: BreakdownRow[]
  /** Metres on the National Cycle Network, or a regional or international equivalent. */
  networkM: number
}

/**
 * How much of the route is what, longest first.
 *
 * Every row is shown. There is no fold into an `Other` tail and there was one until driving
 * the app showed it could never fire: both vocabularies are four classes wide and fixed, so
 * the longest either table can be is four rows. Code that cannot run is worse than no code,
 * because the next reader has to work out why it is there.
 *
 * A class with no distance is dropped rather than shown as a zero. A five-metre row is *not*
 * dropped, and that is deliberate: the tables total the route exactly, which is what lets them
 * be read as a description of it rather than as a summary with an unstated threshold.
 *
 * `lcn` is excluded from the network figure on purpose. It is a council's own signage rather
 * than the National Cycle Network the line names, and in a town it is on half the streets —
 * counting it would turn an interesting figure into a meaningless one.
 */
export function breakdownOf(runs: WayRun[]): Breakdown {
  const road = new Map<RoadClass, number>()
  const surface = new Map<SurfaceClass, number>()
  let networkM = 0

  for (const run of runs) {
    const length = run.toM - run.fromM
    road.set(run.road, (road.get(run.road) ?? 0) + length)
    surface.set(run.surface, (surface.get(run.surface) ?? 0) + length)
    if (onNetwork(run.tags)) networkM += length
  }

  return { road: rank(road, ROAD_LABELS), surface: rank(surface, SURFACE_LABELS), networkM }
}

const onNetwork = (tags: Record<string, string>): boolean =>
  tags.route_bicycle_ncn === 'yes' ||
  tags.route_bicycle_rcn === 'yes' ||
  tags.route_bicycle_icn === 'yes'

function rank<K extends RoadClass | SurfaceClass>(
  totals: Map<K, number>,
  labels: Record<K, string>,
): BreakdownRow[] {
  return [...totals]
    .map(([key, metres]) => ({ key, label: labels[key], metres }))
    .filter((row) => row.metres > 0)
    .sort((one, two) => two.metres - one.metres)
}

/**
 * What gets drawn on the map, and nothing else does.
 *
 * Two marks, both achromatic, both meaning "this stretch is not the ordinary case". Everything
 * that is a paved minor road — most of a British ride — gets nothing, which is the whole
 * design: mark every metre and the line becomes noise a rider learns to ignore; mark only what
 * changes a decision and a dashed stretch means something the first time it appears.
 *
 * A stretch can carry both. They are different layers — a heavier casing beneath the line and
 * a dashed centreline over it — so a gravel B road is drawn as both rather than one winning an
 * argument.
 *
 * Neighbours carrying the same mark are merged, and that is not tidiness. A tag change is
 * enough to end a run, so a single lane can be four runs as `smoothness` appears and
 * disappears; drawn separately, every join is a visible seam in the dash.
 */
export type RunMark = 'unpaved' | 'main'

export interface MarkedRun {
  fromM: number
  toM: number
  mark: RunMark
}

export function markedRuns(runs: WayRun[]): MarkedRun[] {
  const marked: MarkedRun[] = []

  for (const mark of ['unpaved', 'main'] as const) {
    const matches = (run: WayRun) =>
      mark === 'unpaved' ? run.surface === 'loose' || run.surface === 'rough' : run.road === 'main'

    let open: MarkedRun | null = null
    for (const run of runs) {
      if (!matches(run)) {
        open = null
        continue
      }
      if (open && open.toM === run.fromM) {
        open.toM = run.toM
      } else {
        open = { fromM: run.fromM, toM: run.toM, mark }
        marked.push(open)
      }
    }
  }

  return marked
}
