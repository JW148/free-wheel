import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ParsedRoute } from './gpx'
import type { Fix } from './useGeolocation'
import { gradients, nextGradient, type Gradient, type GradientAhead } from './climbs'
import {
  etaSeconds,
  ON_ROUTE,
  rideProgress,
  routeGeometry,
  snapToRoute,
  trackOffRoute,
  type OffRouteState,
  type RideProgress,
  type RouteGeometry,
} from './progress'
import { airDensity, estimatePowerW, ewma } from './power'
import { cdaOf, crrOf, totalMassKg, type RiderSetup } from './rider'
import {
  recordFix,
  startRecording,
  summarise,
  type RideRecord,
  type RideSummary,
} from './recording'

/**
 * Everything the ride screen knows, folded out of one stream of fixes.
 *
 * The pure modules underneath — `progress`, `climbs`, `power`, `recording` — each answer one
 * question and none of them knows about React. This is the only place they meet, and its whole
 * job is sequencing: one fix arrives, and *in order* it is snapped to the route, checked for
 * being off it, turned into a power estimate, and folded into the record.
 *
 * ## Why one effect and not four
 *
 * Because they share the answer. Power needs the gradient, which needs the snap; the record
 * needs the height, which needs the snap; the ETA needs both the snap and the record. Four
 * effects each keyed on `fix` would recompute the snap four times and — worse — would see each
 * other's state one render late, so the ETA would describe the previous fix.
 *
 * ## Why so much lives in refs
 *
 * Fixes arrive about once a second and the compass rather faster. Anything that must survive
 * between fixes without forcing a render — the snap hint, the off-route strike count, the
 * smoothed power — is a ref. What comes out as state is only what the screen draws.
 */

/**
 * How long a smoothed power estimate takes to catch up.
 *
 * Power goes as the cube of speed, so a 15% GPS speed spike is a 50% power spike, and an
 * unsmoothed reading is an unreadable flicker. Eight seconds is long enough to settle and short
 * enough that standing on the pedals shows up before the hill is over.
 */
const POWER_TAU_S = 8

/** Speed is smoothed only to differentiate it. See {@link acceleration}. */
const SPEED_TAU_S = 2.5

/** Beyond this the "acceleration" is a GPS artefact, not a rider. 0.8 m/s² is a hard sprint. */
const MAX_ACCEL_MPS2 = 0.8

export interface RideTelemetry {
  geometry: RouteGeometry | null
  climbs: Gradient[]
  progress: RideProgress | null
  /** The next climb, or the one being ridden. */
  ahead: GradientAhead | null
  /** The next descent — the break the rider is owed. */
  rest: GradientAhead | null
  powerW: number | null
  offRoute: boolean
  /** When the rider was first judged off route, for rate-limiting a reroute. */
  offRouteSince: number | null
  record: RideRecord | null
  etaS: number | null
  /** Wall-clock arrival, in epoch milliseconds. `null` when there is no estimate. */
  arrivalAt: number | null
  /** The last finished ride, held so a summary can be shown after Stop. */
  finished: RideSummary | null
  finishedRecord: RideRecord | null
  dismissFinished: () => void
}

export function useRideTelemetry(input: {
  riding: boolean
  route: ParsedRoute | null
  fix: Fix | null
  rider: RiderSetup
}): RideTelemetry {
  const { riding, route, fix, rider } = input

  const geometry = useMemo(() => (route ? routeGeometry(route) : null), [route])
  const climbs = useMemo(() => (geometry ? gradients(geometry) : []), [geometry])

  const [progress, setProgress] = useState<RideProgress | null>(null)
  const [powerW, setPowerW] = useState<number | null>(null)
  const [offRoute, setOffRoute] = useState<OffRouteState>(ON_ROUTE)
  const [record, setRecord] = useState<RideRecord | null>(null)
  const [finished, setFinished] = useState<RideSummary | null>(null)
  const [finishedRecord, setFinishedRecord] = useState<RideRecord | null>(null)

  // Mirrors `record` so the stop path can summarise it without reading state inside a state
  // updater — updaters must be pure, and StrictMode double-invokes them.
  const recordRef = useRef<RideRecord | null>(null)
  const hintM = useRef<number | null>(null)
  const smoothPower = useRef<number | null>(null)
  const smoothSpeed = useRef<number | null>(null)
  const lastFixAt = useRef<number | null>(null)
  // Read inside the fix effect but deliberately not in its dependencies: changing the rider's
  // weight mid-ride must not replay the fix, and the next fix is a second away.
  const riderRef = useRef(rider)
  riderRef.current = rider
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const ridingRef = useRef(riding)
  ridingRef.current = riding

  // ── Starting and stopping ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (riding) {
      const started = startRecording(Date.now())
      recordRef.current = started
      setRecord(started)
      hintM.current = null
      smoothPower.current = null
      smoothSpeed.current = null
      lastFixAt.current = null
      setOffRoute(ON_ROUTE)
      return
    }
    // Ending a ride: keep the record so the summary has something to describe, and clear the
    // live figures so a stale power reading cannot sit on the planning screen.
    const finishing = recordRef.current
    if (finishing) {
      setFinishedRecord(finishing)
      setFinished(summarise(finishing))
    }
    recordRef.current = null
    setRecord(null)
    setPowerW(null)
  }, [riding])

  // A new route means the old progress describes nothing. This also covers a reroute, which
  // replaces the route under a rider who is still moving.
  //
  // Power is cleared with it. It is derived from the *route's* gradient, so the moment the
  // route changes the last figure describes a hill that is no longer ahead — and leaving a
  // live-looking wattage next to a dashed-out distance is worse than showing nothing for the
  // one second until the next fix.
  useEffect(() => {
    hintM.current = null
    smoothPower.current = null
    setProgress(null)
    setPowerW(null)
    setOffRoute(ON_ROUTE)
  }, [geometry])

  // ── One fix in, everything out ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!fix) return

    const dtS =
      lastFixAt.current === null ? 0 : Math.max(0, (fix.at - lastFixAt.current) / 1000)
    lastFixAt.current = fix.at

    const currentGeometry = geometryRef.current
    let nextProgress: RideProgress | null = null
    if (currentGeometry) {
      const snapped = snapToRoute(currentGeometry, [fix.lon, fix.lat], hintM.current)
      hintM.current = snapped.alongM
      nextProgress = rideProgress(currentGeometry, snapped)
      setProgress(nextProgress)
      setOffRoute((state) =>
        trackOffRoute(state, { offsetM: snapped.offsetM, accuracyM: fix.accuracy, at: fix.at }),
      )
    }

    // Power needs a gradient, and the only trustworthy gradient is the route's. Off route, or
    // with no route at all, the honest answer is that we cannot say.
    let watts: number | null = null
    if (nextProgress && fix.speed !== null) {
      smoothSpeed.current = ewma(smoothSpeed.current, fix.speed, dtS, SPEED_TAU_S)
      const setup = riderRef.current
      const instant = estimatePowerW({
        speedMps: fix.speed,
        grade: nextProgress.grade,
        massKg: totalMassKg(setup),
        cdaM2: cdaOf(setup),
        crr: crrOf(setup),
        rhoKgM3: airDensity(nextProgress.position.elevM),
        accelMps2: acceleration(smoothSpeed.current, fix.speed, dtS),
      })
      watts = ewma(smoothPower.current, instant, dtS, POWER_TAU_S)
      smoothPower.current = watts
      setPowerW(watts)
    } else if (ridingRef.current) {
      setPowerW(null)
    }

    if (ridingRef.current && recordRef.current) {
      recordRef.current = recordFix(recordRef.current, {
        at: fix.at,
        lon: fix.lon,
        lat: fix.lat,
        accuracyM: fix.accuracy,
        speedMps: fix.speed,
        powerW: watts,
        routeElevM: nextProgress ? nextProgress.position.elevM : null,
      })
      setRecord(recordRef.current)
    }
  }, [fix])

  const ahead = useMemo(
    () => (progress ? nextGradient(climbs, progress.position.alongM, 'climb') : null),
    [climbs, progress],
  )
  const rest = useMemo(
    () => (progress ? nextGradient(climbs, progress.position.alongM, 'descent') : null),
    [climbs, progress],
  )

  const etaS = useMemo(() => {
    if (!progress || !route || !geometry) return null
    return etaSeconds({
      remainingM: progress.remainingM,
      plannedM: geometry.totalM,
      plannedTimeS: route.timeS,
      riddenM: record?.distanceM ?? 0,
      movingS: record?.movingS ?? 0,
      fraction: progress.fraction,
    })
  }, [progress, route, geometry, record?.distanceM, record?.movingS])

  const dismissFinished = useCallback(() => {
    setFinished(null)
    setFinishedRecord(null)
  }, [])

  return {
    geometry,
    climbs,
    progress,
    ahead,
    rest,
    powerW,
    offRoute: offRoute.off,
    offRouteSince: offRoute.since,
    record,
    etaS,
    arrivalAt: etaS === null ? null : Date.now() + etaS * 1000,
    finished,
    finishedRecord,
    dismissFinished,
  }
}

/**
 * Acceleration, derived from the *smoothed* speed rather than the raw fix.
 *
 * Differentiating a noisy signal amplifies the noise, and GPS speed is noisy: raw
 * differences give ±3 m/s² at a steady 25 km/h, which through `m·a·v` is ±600 W of pure
 * invention. Taking the difference between the smoothed track and the new sample gives a
 * lagging but stable estimate, and clamping it keeps the worst case bounded.
 *
 * Included at all because a sprint away from traffic lights is real work, and a power readout
 * that ignores it reads flat exactly when the rider is trying hardest.
 */
function acceleration(smoothedMps: number, sampleMps: number, dtS: number): number {
  if (!(dtS > 0)) return 0
  const raw = (sampleMps - smoothedMps) / Math.max(dtS, 1)
  return Math.max(-MAX_ACCEL_MPS2, Math.min(MAX_ACCEL_MPS2, raw))
}
