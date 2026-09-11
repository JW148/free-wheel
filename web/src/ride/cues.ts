import type { Gradient } from './climbs'

/**
 * What to say out loud, and when.
 *
 * ## Why speech at all
 *
 * Every other feature on the riding screen requires a rider to look down. Looking down at
 * 25 km/h is the one thing a cycling app can ask for that has a real cost, and the information
 * that matters most — a wall coming up in 400 m — is exactly the information you want *before*
 * you are on it, when your eyes should be on the road. iOS carries its voices on-device, so
 * this works in airplane mode like everything else here.
 *
 * ## Why so few cues
 *
 * Chattiness is the failure mode. An app that talks constantly gets muted, and a muted app
 * says nothing at all — so the bar for speaking is high and every cue below earns it by
 * changing what the rider does in the next minute:
 *
 * - **A climb coming up** changes your gear and your effort.
 * - **The top of a climb** tells you to stop paying for it. Only for climbs hard enough that
 *   the rider was rationing; nobody needs to be told they have crested a bridge.
 * - **A long descent coming up** is the rest, and knowing it is there changes whether you
 *   push over the top.
 * - **Off route** is the one thing you cannot see coming.
 * - **Nearly there** and **arrived**, because the finish is otherwise a line that stops.
 *
 * Deliberately *not* here: distance ticks every kilometre, speed, power, and anything the
 * screen already shows continuously. If it does not change a decision, it is noise.
 *
 * ## Why this is pure
 *
 * The rules are all "say this once, when this becomes true", which is the kind of logic that
 * silently regresses into repeating itself every second. Keeping the decision separate from
 * `speechSynthesis` means it can be tested by advancing a number.
 */

export interface Cue {
  /** Unique per event, so a cue is spoken once. Not a message — two climbs can share words. */
  key: string
  text: string
}

export interface CueInput {
  alongM: number
  remainingM: number
  climbs: Gradient[]
  offRoute: boolean
  /**
   * When the current off-route episode began, from `trackOffRoute`. `null` while on route.
   *
   * This is what identifies the *episode*, and it has to, because a rider can leave and rejoin
   * the same route any number of times without the geometry ever changing — which is the normal
   * case with automatic rerouting switched off. Keyed on the route alone, the second wrong turn
   * would be met with silence.
   */
  offRouteSince: number | null
  /** Bumped whenever the route is replaced, so cues from the old route cannot block new ones. */
  routeVersion: number
}

/**
 * How far ahead a climb or a descent is announced.
 *
 * There is no lower bound, and there was one at first — 250 m, on the reasoning that a rider
 * almost on a climb can see it. That is true and it is not the case the bound actually caught:
 * cues are said once, so the only rider it silenced was one who *started* the ride inside the
 * window. On the Edinburgh test route the first climb is 200 m in and was never announced at
 * all. So the rule is simply "ahead of you and within 700 m", and being said once does the
 * rest.
 */
const APPROACH_FROM_M = 700

/** Below this a climb is not worth interrupting anyone for. */
const WORTH_SAYING_M = 20

/** A descent has to be this long before "there is a rest coming" is worth saying. */
const REST_M = 800

const FINISH_NEAR_M = 500
const ARRIVED_M = 60

/**
 * The one thing worth saying now, or null.
 *
 * Returns at most one cue per call. Speaking two things at once means hearing neither, and the
 * cases where two would fire together — cresting a climb straight into a descent — read better
 * as two sentences a few seconds apart anyway.
 */
export function cueFor(input: CueInput, said: ReadonlySet<string>): Cue | null {
  const { alongM, remainingM, climbs, offRoute, offRouteSince, routeVersion } = input
  const unsaid = (key: string) => !said.has(key)

  // Off route first: it invalidates everything else that could be said about the route.
  const offKey = `off:${routeVersion}:${offRouteSince ?? 0}`
  if (offRoute && unsaid(offKey)) return { key: offKey, text: 'Off route.' }

  // Versioned like everything else: a reroute produces a new finish to count down to, and
  // without the version a route replaced after arriving would never announce its own.
  const arrivedKey = `arrived:${routeVersion}`
  const finishKey = `finish:${routeVersion}`

  if (remainingM <= ARRIVED_M && unsaid(arrivedKey)) {
    return { key: arrivedKey, text: 'You have arrived.' }
  }
  // Strictly *outside* the arrival radius, and only if arrival has not already been announced.
  // Without both guards a rider whose fix skips 600 m straight to 30 m — or who drifts back
  // out to 400 m after arriving — hears "You have arrived" and then "Finish in 400 metres".
  if (
    remainingM <= FINISH_NEAR_M &&
    remainingM > ARRIVED_M &&
    unsaid(finishKey) &&
    unsaid(arrivedKey)
  ) {
    return { key: finishKey, text: `Finish in ${spokenDistance(remainingM)}.` }
  }

  for (const gradient of climbs) {
    const key = (kind: string) => `${kind}:${routeVersion}:${Math.round(gradient.startM)}`

    if (gradient.kind === 'climb') {
      if (gradient.gainM < WORTH_SAYING_M) continue

      const away = gradient.startM - alongM
      if (away <= APPROACH_FROM_M && away > 0 && unsaid(key('climb'))) {
        return {
          key: key('climb'),
          text: `Climb in ${spokenDistance(away)}. ${Math.round(gradient.gainM)} metres at ${spokenGrade(gradient.grade)}${
            gradient.maxGrade > gradient.grade + 0.02
              ? `, steepening to ${spokenGrade(gradient.maxGrade)}`
              : ''
          }.`,
        }
      }

      // The top. Only for a climb the rider was rationing effort for — being told you have
      // crested a railway bridge is the kind of cue that gets an app muted.
      const hard = gradient.severity === 'hard' || gradient.severity === 'brutal'
      if (hard && alongM > gradient.endM && alongM < gradient.endM + 150 && unsaid(key('top'))) {
        return { key: key('top'), text: 'Top of the climb.' }
      }
    }

    if (gradient.kind === 'descent' && gradient.lengthM >= REST_M) {
      const away = gradient.startM - alongM
      if (away <= APPROACH_FROM_M && away > 0 && unsaid(key('rest'))) {
        return {
          key: key('rest'),
          text: `Downhill in ${spokenDistance(away)}, for ${spokenDistance(gradient.lengthM)}.`,
        }
      }
    }
  }

  return null
}

/**
 * A distance a synthesiser reads well.
 *
 * "450 m" is read as "four hundred and fifty em" by some voices, and "1.2 km" as "one point two
 * kay em" by others. Spelling the unit out and rounding hard is the difference between a cue
 * that is understood at 25 km/h and one that has to be worked out.
 */
export function spokenDistance(metres: number): string {
  if (metres < 1000) {
    const rounded = Math.max(50, Math.round(metres / 50) * 50)
    return `${rounded} metres`
  }
  const km = metres / 1000
  return km < 10 ? `${km.toFixed(1)} kilometres` : `${Math.round(km)} kilometres`
}

/** "6 percent". Never a decimal: a gradient read to one decimal place is unhearable. */
export function spokenGrade(grade: number): string {
  return `${Math.abs(Math.round(grade * 100))} percent`
}
