/**
 * How much climbing a line of heights represents.
 *
 * Its own module, with no imports, because three places need the same answer and two of them
 * cannot import each other: `gpx.ts` parses a recorded track and has to report its total,
 * `progress.ts` accumulates the same figure per vertex so it can say how much is *left*, and
 * `elevation.ts` draws it. A shared constant is the point — two deadbands would mean the
 * stats rail and the climb list disagreeing by tens of metres about the same hill.
 */

/**
 * Height change ignored before it counts as climbing.
 *
 * Not an arbitrary smoothing constant: 6 m is SRTM's stated vertical accuracy, so anything
 * smaller cannot be distinguished from the data being wrong. Summing *every* positive step
 * instead gives 943 m on the London–Brighton fixture against BRouter's own filtered figure of
 * **592 m** — a number this app displays right next to it. With the deadband it comes to
 * 589 m, and 0 m against BRouter's 1 m on the urban fixture. Agreement to within half a
 * percent on a figure derived two entirely different ways is about as good as it gets.
 */
export const ASCENT_DEADBAND_M = 6

/**
 * Total metres climbed, with the deadband applied.
 *
 * The reference follows the line *down* as well as up. Without that, a long descent leaves it
 * stranded at the summit and the next small rise is credited with the whole way back.
 */
export function filteredAscentM(elevations: readonly number[]): number {
  if (elevations.length === 0) return 0
  let reference = elevations[0]
  let climbed = 0
  for (let i = 1; i < elevations.length; i++) {
    const here = elevations[i]
    if (here - reference >= ASCENT_DEADBAND_M) {
      climbed += here - reference
      reference = here
    } else if (reference - here >= ASCENT_DEADBAND_M) {
      reference = here
    }
  }
  return climbed
}
