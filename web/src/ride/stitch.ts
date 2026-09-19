import { haversineM } from './geo'
import type { ParsedRoute, TurnAt, WayTagsAt } from './gpx'
import { ascentBy, elevationAt, pointAt, type RouteGeometry } from './progress'

/**
 * Joining the road already ridden to the road just computed.
 *
 * ## The thing this fixes
 *
 * A reroute used to *replace* the route: the engine was asked for a line from the rider's
 * current position to the finish, and whatever came back became the whole plan. Arithmetically
 * that is the right question — it is the road still to ride — and as a thing to look at, half
 * way round a 50 km loop, it is wrong in every figure on the screen at once. The trip becomes
 * 28 km long, the progress bar goes back to zero, the climbing done falls to nothing, and the
 * start point moves to a layby on the A701. Nothing about the ride changed; the rider took a
 * wrong turn and the app forgot the first two hours.
 *
 * So a reroute now **adds to** the journey rather than replacing it. The part already ridden is
 * cut out of the old route at the point the rider left it, the fresh line is joined onto the
 * end, and the result is one route that runs from the original start to the original finish and
 * knows the rider is 22 km into it. The plan's waypoints do the same thing: the original start
 * and every via already passed are kept, and the rider's current position joins them as one
 * more point along the way. That is what "keep the original start" means when you say it in
 * terms the engine can be asked about again later.
 *
 * ## What the figures are made of afterwards
 *
 * The prefix's numbers come from the geometry the app built, the suffix's from BRouter's own
 * summary, and they are simply added. The two are measured slightly differently — `cumulativeM`
 * is a sum of haversines over the track points, `track-length` is BRouter's own — and over
 * tens of kilometres they differ by a few metres. That is invisible next to a GPS fix and is
 * the price of not re-routing the part of the ride that already happened.
 *
 * Time is pro-rated over the prefix rather than added, because there is no per-point time in a
 * GPX to slice: an hour into a two-hour route, half the estimate is behind you. `shortest` has
 * no estimate at all, and `null` survives the whole way through rather than becoming a zero.
 *
 * ## The gap is real and is counted
 *
 * The prefix ends where the rider *left* the route and the suffix starts where they *are*, and
 * those are different places — that distance is why there was a reroute. It is added to the
 * total as a straight line, which is what the drawn route shows and is honest about: nobody
 * knows what road they took across it, only that they covered it.
 */

/** The part of a route that is already behind the rider, cut at a distance along it. */
export interface RiddenPrefix {
  coords: [number, number][]
  elevations: number[]
  /** Distance from the original start to the cut, metres. */
  distanceM: number
  /** Filtered ascent from the original start to the cut, metres. */
  ascentM: number
  /** Pro-rated share of the original estimate, or `null` for a profile with no energy model. */
  timeS: number | null
  /**
   * The road tags and the junctions that fall before the cut, indexed as they already were.
   *
   * A prefix is a *leading* slice, so every index it keeps means the same point it always
   * did. Only the suffix needs shifting, which is why this pair is carried rather than
   * recomputed — and why a bug here would show up as the second half of a rerouted ride
   * describing the first half's roads.
   */
  ways: WayTagsAt[]
  turns: TurnAt[]
}

/**
 * Cuts a route at `alongM`, keeping everything before it.
 *
 * The cut point is interpolated rather than snapped to the nearest track point, so the
 * stitched route passes exactly through where the rider left it — a line that jumps back
 * twenty metres to the last vertex is a line the progress bar then has to explain.
 */
export function riddenPrefix(
  geometry: RouteGeometry,
  route: ParsedRoute,
  alongM: number,
): RiddenPrefix {
  const cut = Math.max(0, Math.min(alongM, geometry.totalM))

  const coords: [number, number][] = []
  const elevations: number[] = []
  // A plain scan rather than a binary search: this runs once per reroute, against a search
  // that takes seconds.
  let kept = 0
  for (let i = 0; i < geometry.coords.length; i++) {
    if (geometry.cumulativeM[i] > cut) break
    coords.push(geometry.coords[i])
    elevations.push(geometry.elevations[i] ?? 0)
    kept = i + 1
  }

  // The interpolated cut, unless the rider is standing on a vertex already.
  const edge = pointAt(geometry, cut)
  const tail = coords[coords.length - 1]
  if (!tail || tail[0] !== edge[0] || tail[1] !== edge[1]) {
    coords.push(edge)
    elevations.push(elevationAt(geometry, cut))
  }

  return {
    coords,
    elevations,
    distanceM: cut,
    ascentM: ascentBy(geometry, cut),
    timeS:
      route.timeS === null || geometry.totalM <= 0
        ? null
        : route.timeS * (cut / geometry.totalM),
    // `kept`, not `coords.length`: the interpolated cut point was pushed on the end and is
    // not an original index, so anything at or past `kept` belongs to the road ahead — which
    // is the half being thrown away and re-routed.
    ways: (route.ways ?? []).filter((way) => way.index < kept),
    // The junctions already passed are kept rather than dropped. Nothing reads backwards, so
    // they cost nothing while riding, and a stitched route saved and reopened is then a route
    // that can still describe its whole self.
    turns: (route.turns ?? []).filter((turn) => turn.index < kept),
  }
}

/**
 * The ridden part and the fresh part, as one route.
 *
 * `resumeAtM` is the load-bearing extra. `snapToRoute` searches a window around a hint first
 * and only falls back to a global scan, and a global scan on a stitched route is exactly the
 * failure the hint exists to prevent: the prefix is a road the rider has already been down, so
 * on an out-and-back the first fix after a reroute can snap them to where they were half an
 * hour ago. The stitched route therefore carries the distance at which the rider rejoined it,
 * and the telemetry seeds its hint with that rather than starting blind.
 */
export function stitchRoute(prefix: RiddenPrefix, fresh: ParsedRoute): ParsedRoute {
  const joinFrom = prefix.coords[prefix.coords.length - 1]
  const joinTo = fresh.coords[0]
  const gapM = joinFrom && joinTo ? haversineM(joinFrom, joinTo) : 0

  // The fresh half's points land after the prefix's, so every index it carries moves by the
  // prefix's length. Without this the road ahead would be described using the tags of the road
  // already ridden — and the turns would be announced for junctions an hour behind.
  const shift = prefix.coords.length
  const ways = [...prefix.ways, ...(fresh.ways ?? []).map(shiftBy(shift))]
  const turns = [...prefix.turns, ...(fresh.turns ?? []).map(shiftBy(shift))]

  return {
    coords: [...prefix.coords, ...fresh.coords],
    elevations: [...prefix.elevations, ...fresh.elevations],
    distanceM: prefix.distanceM + gapM + fresh.distanceM,
    ascendM: prefix.ascentM + fresh.ascendM,
    timeS: prefix.timeS === null || fresh.timeS === null ? null : prefix.timeS + fresh.timeS,
    name: fresh.name,
    resumeAtM: prefix.distanceM + gapM,
    // Undefined, not empty, when neither half had any — the same distinction everywhere else
    // makes between a route that cannot describe itself and one with nothing to say.
    ways: ways.length > 0 ? ways : undefined,
    turns: turns.length > 0 ? turns : undefined,
  }
}

const shiftBy =
  (by: number) =>
  <T extends { index: number }>(item: T): T => ({ ...item, index: item.index + by })

/**
 * The stitched route as a GPX document.
 *
 * This is a second GPX *writer*, and the project rule against one — "parse BRouter's GPX; don't
 * add a second output format" — deliberately does not apply, for the same reason it does not
 * apply to `traceToGpx`. That rule protects the byte-for-byte parity corpus, which covers what
 * the engine computed. A stitched route is two engine outputs with a join in the middle; there
 * is nothing for it to be in parity with, and the alternative is a rider who reroutes once and
 * can then no longer save or export the ride they are on.
 *
 * It is written in `FormatGpx`'s own shape — the summary comment first, one `<trkpt>` per line
 * — so `parseBrouterGpx` reads it back without a second parser and a stitched route reloaded
 * from the library behaves like any other.
 */
export function stitchedGpx(route: ParsedRoute, name: string): string {
  // Written in mode 9's shape as well as `FormatGpx`'s, so a stitched route saved to the
  // library and reopened still knows what it is made of and where it turns. Without this a
  // rider who took one wrong turn would find their saved ride had lost its surfaces and its
  // junctions — which is the half of the ride they most wanted to look at again.
  const wayAt = new Map((route.ways ?? []).map((way) => [way.index, way]))
  const turnAt = new Map((route.turns ?? []).map((turn) => [turn.index, turn]))

  const points = route.coords
    .map((point, i) => {
      const ele = route.elevations[i]
      const height = ele === undefined ? '' : `<ele>${ele.toFixed(2)}</ele>`
      const turn = turnAt.get(i)
      const sym = turn ? `<sym>${escapeXml(turn.command)}</sym>` : ''
      const way = wayAt.get(i)
      const tags = way
        ? `<extensions><brouter:way>${escapeXml(
            Object.entries(way.tags)
              .map(([key, value]) => `${key}=${value}`)
              .join(' '),
          )}</brouter:way></extensions>`
        : ''
      return `   <trkpt lon="${point[0].toFixed(6)}" lat="${point[1].toFixed(6)}">${height}${sym}${tags}</trkpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- track-length = ${Math.round(route.distanceM)} filtered ascend = ${Math.round(route.ascendM)} plain-ascend = 0 cost=0 energy=.0kwh${formatTime(route.timeS)} -->
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:brouter="Not yet documented" version="1.1" creator="free-wheel">
 <trk>
  <name>${escapeXml(name)}</name>
  <trkseg>
${points}
  </trkseg>
 </trk>
</gpx>
`
}

/**
 * BRouter's own `time=` shape, or nothing at all.
 *
 * Nothing at all is the important half: `shortest.brf` has no energy model, so BRouter emits no
 * `time=` and `parseBrouterGpx` reports `null`. Writing `time=0s` here would turn "we cannot
 * say" into "no time", which the UI renders as `0 min`.
 */
function formatTime(seconds: number | null): string {
  if (seconds === null) return ''
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return ` time=${h > 0 ? `${h}h ` : ''}${h > 0 || m > 0 ? `${m}m ` : ''}${s}s`
}

function escapeXml(text: string): string {
  return text.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  )
}
