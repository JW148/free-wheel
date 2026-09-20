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

/**
 * Which way a gesture on the panel turned out to be going.
 *
 * The panel has two axes now: down to grow it, sideways to change the page. A finger does not
 * declare which it meant, so the first dozen pixels decide — the same shape `sheetDrag`'s
 * `pendingVerdict` uses to tell a drag from a scroll, and for the same reason. Committing on
 * the very first move instead would make every page swipe begin by resizing the panel a few
 * pixels, which is the one thing it must not do while figures are being read.
 *
 * `wait` is not a failure. It is the honest answer until one axis is clearly ahead, and the
 * caller writes nothing while it holds.
 */
export type HudAxis = 'wait' | 'resize' | 'page'

/** Far enough to mean it. The same distance the sheet's body drag waits for. */
const AXIS_COMMIT_PX = 12

export function hudAxis(acrossPx: number, downPx: number): HudAxis {
  const across = Math.abs(acrossPx)
  const down = Math.abs(downPx)
  if (Math.max(across, down) < AXIS_COMMIT_PX) return 'wait'
  // A tie goes to resizing, which is the gesture the panel had first and the one a rider
  // reaches for without looking.
  return across > down ? 'page' : 'resize'
}

/**
 * Which page a sideways release lands on.
 *
 * Half a page of travel, or a flick, and it moves. Clamped to the pages that exist, which is
 * what stops a swipe past the end parking the track in the margin.
 *
 * Deliberately not `wasTap`-guarded the way {@link hudRelease} is: by the time this is reached
 * the gesture has already travelled far enough for {@link hudAxis} to have called it a page
 * swipe, so a tap cannot arrive here.
 */
export function hudPageRelease({
  from,
  travelledPx,
  velocityPxPerS,
  widthPx,
  pages,
}: {
  from: number
  /** Positive when the finger moved right, which reveals the page *before* this one. */
  travelledPx: number
  velocityPxPerS: number
  widthPx: number
  pages: number
}): number {
  const flicked = Math.abs(velocityPxPerS) > FLICK_PX_PER_S
  const dragged = widthPx > 0 && Math.abs(travelledPx) / widthPx >= SETTLE
  const step = flicked
    ? -Math.sign(velocityPxPerS)
    : dragged
      ? -Math.sign(travelledPx)
      : 0
  return Math.min(pages - 1, Math.max(0, from + step))
}
