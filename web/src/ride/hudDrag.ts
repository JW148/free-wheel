import { sheetProgress, wasTap } from './sheetDrag'

/**
 * The arithmetic behind the riding panel's one gesture.
 *
 * The HUD has two sizes — the strip and the graph — and, now, a finger anywhere between them.
 * It is the plan sheet's mechanism turned upside down: the sheet grows upwards from the bottom
 * of the screen and the panel grows downwards from the top, so a pull *down* is the one that
 * opens this. Everything here is in pixels of panel height with `travelledPx` positive towards
 * {@link HudStop `full`}, which is the direction the glass agrees with.
 *
 * The progress arithmetic is literally the sheet's — two stops, a range, a clamp — so it is
 * borrowed rather than rewritten. What differs is the release, and only in one respect: see
 * below.
 */

/** The strip, and the panel with the elevation graph on it. */
export type HudStop = 'mini' | 'full'

/** Fast enough to be a throw rather than a placement, in pixels per second. */
const FLICK_PX_PER_S = 500

/** Where a release settles when nothing was thrown: the nearer size, with no hysteresis. */
const SETTLE = 0.5

/** How far between the two sizes the panel is, 0 on the strip and 1 on the graph. */
export function hudProgress({
  from,
  travelledPx,
  rangePx,
}: {
  from: HudStop
  travelledPx: number
  rangePx: number
}): number {
  return sheetProgress({ from: from === 'full' ? 'open' : 'card', travelledPx, rangePx })
}

/**
 * Which size a release lands on.
 *
 * **A tap does not toggle**, which is the one place this parts company with the sheet. The
 * sheet's gesture starts on a handle — a control, which has to do something when pressed. This
 * one starts anywhere on a panel that occupies the top quarter of the riding screen, which is
 * also where a hand goes when it comes back to the bars. Toggling on contact would mean the
 * figures a rider is halfway through reading change size because they steadied the phone.
 *
 * So the panel is dragged to change, and the chevron is pressed to change. A press that was
 * not a drag leaves it exactly where it was.
 */
export function hudRelease({
  from,
  travelledPx,
  velocityPxPerS,
  rangePx,
}: {
  from: HudStop
  travelledPx: number
  velocityPxPerS: number
  rangePx: number
}): HudStop {
  if (wasTap(travelledPx)) return from

  // The direction of travel at the moment of release is the more recent statement of intent,
  // so it beats how far the panel happened to get.
  if (Math.abs(velocityPxPerS) > FLICK_PX_PER_S) return velocityPxPerS > 0 ? 'full' : 'mini'

  return hudProgress({ from, travelledPx, rangePx }) >= SETTLE ? 'full' : 'mini'
}
