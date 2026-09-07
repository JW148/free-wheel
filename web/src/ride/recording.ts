import { haversineM } from './geo'

/**
 * What actually happened on the ride, as opposed to what was planned.
 *
 * A pure reducer over fixes. Every figure the summary screen shows is accumulated here, one
 * fix at a time, so the whole thing can be tested by feeding it a made-up ride — which matters
 * more than usual, because the alternative way to test it is to go outside for two hours.
 *
 * ## The rules exist because GPS lies in specific ways
 *
 * Three failure modes, all of which produce a wrong number rather than an obvious error:
 *
 * - **Jitter at a standstill.** A phone waiting at traffic lights wanders by a few metres a
 *   second. Unfiltered, a ten-minute café stop adds a kilometre to the ride.
 * - **Teleports.** A fix arriving after a tunnel jumps hundreds of metres in one step, which
 *   is not distance ridden.
 * - **Gaps.** iOS suspends a backgrounded app, so the next fix can be twenty minutes later.
 *   Elapsed time should count that; moving time and energy must not.
 *
 * ## Why ascent comes from the route and not the fixes
 *
 * Barometric altitude is not available to a web app, and GPS altitude is the worst channel a
 * phone has — routinely tens of metres out, and drifting while stationary. Summing its positive
 * deltas over a long ride produces hundreds of metres of climbing that never happened. The
 * route's own SRTM elevations, sampled at the snapped position, are stable and smooth. The
 * trade is that ascent stops accumulating while off route, which is stated in the UI rather
 * than hidden.
 */

export interface RideSample {
  at: number
  lon: number
  lat: number
  accuracyM: number
  /** From the fix. `null` when iOS declines to report one, which it does when barely moving. */
  speedMps: number | null
  /** The estimate from `power.ts`, or null when there is no route to take a gradient from. */
  powerW: number | null
  /** Height at the snapped position on the route. Null while off route. */
  routeElevM: number | null
}

export interface TracePoint {
  lon: number
  lat: number
  elevM: number | null
  at: number
}

export interface RideRecord {
  startedAt: number
  /** The most recent fix, so elapsed time does not run on after the app is closed. */
  lastAt: number
  movingS: number
  distanceM: number
  ascentM: number
  energyKj: number
  maxSpeedMps: number
  /** Watt-seconds, so the average is time-weighted rather than fix-weighted. */
  powerWs: number
  powerS: number
  /** Where the rider actually went. Thinned; see {@link TRACE_SPACING_M}. */
  trace: TracePoint[]
  /** The last accepted position, which is what distance is measured from. */
  anchor: { lon: number; lat: number; at: number } | null
  /** {@link distanceM} at the last trace point, so the trace thins by distance ridden. */
  tracedAtM: number
  /** The last route height counted towards ascent. */
  lastElevM: number | null
}

/** Below this, a "move" is the receiver wandering while the bike is stationary. */
const MIN_STEP_M = 6
/** A fix this vague cannot say whether the bike moved at all. */
const MAX_ACCURACY_M = 50
/** 30 m/s is 108 km/h. Beyond that it is a teleport, not a descent. */
const MAX_SPEED_MPS = 30
/** Longer than this between fixes and the app was asleep; time did not pass *on the bike*. */
const MAX_GAP_S = 20
/** Below this the rider is stopped, whatever the receiver says. */
const MOVING_MPS = 0.8
/**
 * Height change ignored before it counts as climbing.
 *
 * Even the route's elevations are SRTM, so they carry metre-scale steps; summing every
 * positive one over 90 km inflates the total. One metre is the smallest step in the data.
 */
const ASCENT_DEADBAND_M = 1
/** Trace points are thinned to this spacing. 10 m is finer than the fixes on most bikes. */
const TRACE_SPACING_M = 10

export function startRecording(at: number): RideRecord {
  return {
    startedAt: at,
    lastAt: at,
    movingS: 0,
    distanceM: 0,
    ascentM: 0,
    energyKj: 0,
    maxSpeedMps: 0,
    powerWs: 0,
    powerS: 0,
    trace: [],
    anchor: null,
    tracedAtM: 0,
    lastElevM: null,
  }
}

/**
 * Folds one fix into the record.
 *
 * Returns a new record rather than mutating, so React sees the change and so a test can hold
 * on to an earlier state. The trace array is copied only when a point is actually added —
 * which is most of the time, but not while stopped, and a café stop should not reallocate a
 * 10,000-element array once a second.
 */
export function recordFix(record: RideRecord, sample: RideSample): RideRecord {
  const gapS = Math.max(0, (sample.at - record.lastAt) / 1000)
  // A gap longer than MAX_GAP_S means the app was suspended. Wall-clock elapsed still counts
  // it — you were out on the bike — but nothing rate-based may, or a twenty-minute suspension
  // becomes twenty minutes at the last known power.
  const dtS = Math.min(gapS, MAX_GAP_S)

  const next: RideRecord = { ...record, lastAt: Math.max(record.lastAt, sample.at) }

  const usable = sample.accuracyM <= MAX_ACCURACY_M
  const speedMps = sample.speedMps ?? null

  if (usable && speedMps !== null && speedMps <= MAX_SPEED_MPS) {
    next.maxSpeedMps = Math.max(record.maxSpeedMps, speedMps)
  }

  const moving = speedMps !== null ? speedMps >= MOVING_MPS : false
  if (moving) next.movingS = record.movingS + dtS

  if (sample.powerW !== null && moving) {
    next.energyKj = record.energyKj + (sample.powerW * dtS) / 1000
    next.powerWs = record.powerWs + sample.powerW * dtS
    next.powerS = record.powerS + dtS
  }

  if (usable) {
    const stepM = record.anchor
      ? haversineM([record.anchor.lon, record.anchor.lat], [sample.lon, sample.lat])
      : 0
    const stepS = record.anchor ? Math.max(0.001, (sample.at - record.anchor.at) / 1000) : 0
    const plausible = record.anchor === null || stepM / stepS <= MAX_SPEED_MPS

    if (record.anchor === null) {
      next.anchor = { lon: sample.lon, lat: sample.lat, at: sample.at }
      next.trace = [...record.trace, point(sample)]
    } else if (stepM >= MIN_STEP_M && plausible) {
      next.distanceM = record.distanceM + stepM
      next.anchor = { lon: sample.lon, lat: sample.lat, at: sample.at }
      // Thinned by distance *ridden*, not by the size of one step: fixes arrive every 8 m or
      // so, and comparing a single step against the spacing meant no point was ever added
      // after the first.
      if (next.distanceM - record.tracedAtM >= TRACE_SPACING_M) {
        next.trace = [...record.trace, point(sample)]
        next.tracedAtM = next.distanceM
      }
    } else if (!plausible) {
      // Re-anchor without crediting the jump, so the *next* step is measured from where the
      // rider actually is rather than from where they were before the tunnel. The trace keeps
      // the new point so the drawn track does not run through the hillside.
      next.anchor = { lon: sample.lon, lat: sample.lat, at: sample.at }
      next.trace = [...record.trace, point(sample)]
      next.tracedAtM = record.distanceM
    }
  }

  if (sample.routeElevM !== null) {
    if (record.lastElevM === null) {
      next.lastElevM = sample.routeElevM
    } else {
      const rise = sample.routeElevM - record.lastElevM
      if (rise >= ASCENT_DEADBAND_M) {
        next.ascentM = record.ascentM + rise
        next.lastElevM = sample.routeElevM
      } else if (rise <= -ASCENT_DEADBAND_M) {
        // Track downwards too, or a long descent leaves the reference stuck at the summit and
        // the next small rise is credited with the whole descent back.
        next.lastElevM = sample.routeElevM
      }
    }
  }

  return next
}

const point = (sample: RideSample): TracePoint => ({
  lon: sample.lon,
  lat: sample.lat,
  elevM: sample.routeElevM,
  at: sample.at,
})

export interface RideSummary {
  startedAt: number
  endedAt: number
  /** Wall clock, including stops. */
  elapsedS: number
  movingS: number
  distanceM: number
  ascentM: number
  energyKj: number
  /** Over moving time, not elapsed — the figure a rider means by "I averaged 24". */
  avgSpeedMps: number
  maxSpeedMps: number
  /** Time-weighted mean over the moving time, or null if nothing was ever estimated. */
  avgPowerW: number | null
}

export function summarise(record: RideRecord): RideSummary {
  return {
    startedAt: record.startedAt,
    endedAt: record.lastAt,
    elapsedS: Math.max(0, (record.lastAt - record.startedAt) / 1000),
    movingS: record.movingS,
    distanceM: record.distanceM,
    ascentM: record.ascentM,
    energyKj: record.energyKj,
    avgSpeedMps: record.movingS > 0 ? record.distanceM / record.movingS : 0,
    maxSpeedMps: record.maxSpeedMps,
    avgPowerW: record.powerS > 0 ? record.powerWs / record.powerS : null,
  }
}

/** Whether a ride is worth offering to save. A 40 m ride is a mis-tap on Start. */
export function worthKeeping(record: RideRecord): boolean {
  return record.distanceM >= 200 && record.trace.length >= 2
}

/**
 * The ride, as a GPX track.
 *
 * This is a *second* GPX writer in the app, and the project rule against that
 * ("parse BRouter's GPX; don't add a second output format") deliberately does not apply: that
 * rule protects the byte-for-byte parity corpus, which covers routes the engine computed. A
 * recorded ride never went near the engine — there is nothing to be in parity with — and the
 * alternative is a rider who cannot get their ride into Strava.
 *
 * Timestamps are included, which is what makes it a *ride* rather than a route: without them
 * every downstream tool treats it as a plan and reports no speed.
 */
export function traceToGpx(record: RideRecord, name: string): string {
  const points = record.trace
    .map((p) => {
      const ele = p.elevM === null ? '' : `<ele>${p.elevM.toFixed(1)}</ele>`
      return `   <trkpt lon="${p.lon.toFixed(6)}" lat="${p.lat.toFixed(6)}">${ele}<time>${new Date(p.at).toISOString()}</time></trkpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="free-wheel">
 <metadata><name>${escapeXml(name)}</name><time>${new Date(record.startedAt).toISOString()}</time></metadata>
 <trk>
  <name>${escapeXml(name)}</name>
  <trkseg>
${points}
  </trkseg>
 </trk>
</gpx>
`
}

function escapeXml(text: string): string {
  return text.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  )
}
