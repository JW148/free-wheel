import { angleGap } from './geo'

/**
 * When the riding map moves, and which way the rider is pointing — the decisions, without a map.
 *
 * ## Why this exists
 *
 * A ride drained a phone at about 1% a minute, and the map was the reason: it was almost never
 * still. The camera effect issued a 700 ms `easeTo` on every GPS fix, which at one fix a second
 * is a map animating 70% of the time while riding in a straight line — and it also listed the
 * compass heading in its dependencies, and a phone on a handlebar mount moves its compass reading
 * several times a second. Each one restarted the animation, and re-rendered the riding screen on
 * the way, *including with course-up off*, where the heading had nothing to rotate. A map that
 * is moving is a GPU drawing every frame the display can show; a map at rest draws nothing.
 *
 * So the rules here are all about not moving:
 *
 * - **One camera move per fix at most, and only when it is needed.** The rider's dot is allowed
 *   to wander inside a box in the middle of the screen, and the camera only catches up when it
 *   leaves — a lazy follow, as every in-car navigator does. At street zoom and cycling pace the
 *   dot crosses that box in ten seconds or so, so the camera moves about once every ten fixes
 *   instead of every one of them.
 * - **The compass alone never moves the camera.** With course-up on, the map turns on the next
 *   fix, and only if the heading has drifted past {@link BEARING_DEADBAND_DEG}. With it off, the
 *   compass has nothing to say to the camera at all.
 * - **The GPS course beats the compass while moving.** It is clean, and it is what the bike is
 *   doing rather than where the handlebars point. The compass is for the cases the course
 *   cannot cover — standing at a junction, at the lights, wheeling the bike — where iOS reports
 *   no course at all.
 * - **The arrow turns on a real change, not on noise** — {@link ARROW_DEADBAND_DEG}, and no more
 *   than {@link ARROW_MIN_INTERVAL_MS} apart.
 *
 * Recentring and rotating are still one `easeTo`: {@link cameraStep} returns both halves of the
 * move together, and the effect that issues it runs once per fix. See the note in `CLAUDE.md`
 * on why two effects each issuing their own cancel each other.
 */

/** Above this, the GPS course is trusted over the compass. About 9 km/h: walking pace and up. */
export const MOVING_MPS = 2.5

/**
 * How far the heading must drift before course-up turns the map.
 *
 * A map turning by a couple of degrees every second is the whole cost this module exists to cut,
 * and nobody reads a map to better than this anyway. A turn at a junction is 45° or more.
 */
export const BEARING_DEADBAND_DEG = 12

/** How far the compass must move before the rider's arrow is redrawn. */
export const ARROW_DEADBAND_DEG = 8

/** And no more often than this, however much the compass swings. */
export const ARROW_MIN_INTERVAL_MS = 500

/**
 * The middle of the screen the rider's dot may wander in before the camera follows, as a
 * fraction of the viewport's width and height either side of the centre.
 *
 * 0.15 is ±58 px on a 390 px phone: about eleven seconds of riding at 20 km/h at the riding
 * zoom of 16.5, and comfortably inside the area the HUD and the bottom bar leave uncovered.
 */
export const FOLLOW_BOX = 0.15

export type HeadingSource = 'compass' | 'course'

/**
 * Which heading to use: the GPS course while moving, the compass while not.
 *
 * Falls back either way rather than reporting nothing. A course with no speed reported is
 * still a course, and a compass at speed is still better than a map that does not know which
 * way is forward.
 */
export function chooseHeading({
  compass,
  course,
  speedMps,
}: {
  compass: number | null
  course: number | null
  speedMps: number | null
}): { heading: number | null; source: HeadingSource | null } {
  const moving = speedMps !== null && speedMps >= MOVING_MPS
  if (course !== null && (moving || compass === null)) return { heading: course, source: 'course' }
  if (compass !== null) return { heading: compass, source: 'compass' }
  return { heading: null, source: null }
}

/**
 * Whether a new smoothed compass reading should replace the one on screen.
 *
 * The first reading always does. After that it has to have moved by
 * {@link ARROW_DEADBAND_DEG} *and* the last change has to be {@link ARROW_MIN_INTERVAL_MS} old:
 * the deadband alone lets a compass oscillating either side of the band through at sixty
 * hertz, and the interval alone would redraw an arrow that has not visibly moved.
 */
export function shouldPublishCompass({
  shown,
  shownAtMs,
  next,
  nowMs,
}: {
  shown: number | null
  shownAtMs: number | null
  next: number
  nowMs: number
}): boolean {
  if (shown === null || shownAtMs === null) return true
  if (nowMs - shownAtMs < ARROW_MIN_INTERVAL_MS) return false
  return angleGap(shown, next) >= ARROW_DEADBAND_DEG
}

/** Whether a point on screen has left the box in the middle the dot may wander in. */
export function outsideFollowBox(
  dot: { x: number; y: number },
  viewport: { width: number; height: number },
  box = FOLLOW_BOX,
): boolean {
  const dx = Math.abs(dot.x - viewport.width / 2)
  const dy = Math.abs(dot.y - viewport.height / 2)
  return dx > viewport.width * box || dy > viewport.height * box
}

export interface CameraMove {
  /** Recentre on the fix. */
  centre: boolean
  /** Turn to this bearing, or leave the bearing alone. */
  bearing: number | null
}

/**
 * The one camera move for this fix, or `null` for none — which is the common answer.
 *
 * `force` is for the moments the rider asked for the camera: a ride starting, follow resuming
 * after a pan, course-up being switched. Then the map recentres and turns at once, whatever the
 * box and the deadband say, because a button that appears to do nothing is a broken button.
 *
 * The bearing goes back to north when course-up is off or nothing is being followed — but
 * deliberately **not** while following is merely paused. Panning to look up the road should not
 * spin the map under the rider's thumb and spin it back twelve seconds later.
 *
 * **Nothing interrupts a move already in flight**, unless forced. `easeTo` stops whatever is
 * animating and keeps the zoom it had reached, so Start's 900 ms zoom to street level was being
 * cut short by the first fix's recentre — measured in the headless driver, the ride ran the
 * whole way at z8.5, the overview the plan was framed at. Recentre's zoom-in had the same
 * exposure. The next fix catches up; a second's lag on a camera that already lags by design is
 * invisible.
 */
export function cameraStep({
  following,
  paused,
  courseUp,
  heading,
  bearingNow,
  dot,
  viewport,
  force,
  animating = false,
}: {
  following: boolean
  paused: boolean
  courseUp: boolean
  heading: number | null
  bearingNow: number
  /** The fix, projected onto the screen. Null with no fix. */
  dot: { x: number; y: number } | null
  viewport: { width: number; height: number }
  force: boolean
  /** Whether the map is already moving — a zoom from Start or Recentre, or the last follow. */
  animating?: boolean
}): CameraMove | null {
  if (animating && !force) return null
  const locked = following && !paused
  const northUp = !courseUp || !following

  let bearing: number | null = null
  if (locked && courseUp && heading !== null) {
    if (force || angleGap(bearingNow, heading) >= BEARING_DEADBAND_DEG) bearing = heading
  } else if (northUp && bearingNow !== 0) {
    bearing = 0
  }

  const centre = locked && dot !== null && (force || outsideFollowBox(dot, viewport))
  if (!centre && bearing === null) return null
  return { centre, bearing }
}
