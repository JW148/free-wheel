/**
 * The arithmetic behind the plan sheet's one gesture.
 *
 * The sheet has two stops — the card and the open sheet — and a finger anywhere between them.
 * Everything here is in pixels of sheet height rather than screen coordinates, because the
 * hook that calls it already knows which way is up and this does not have to: a positive
 * `travelledPx` means *towards open*, whichever direction that was on the glass.
 *
 * It is pure so that the part with a decision in it can be tested, which the part with a
 * pointer in it cannot. `useSheetDrag` is then only bookkeeping: subtract two clientYs, keep
 * the last one and its timestamp, and hand the numbers over.
 */

export type SheetStop = 'card' | 'open'

/** Under this, the finger did not move: it was a tap on the handle, not a drag. */
const TAP_SLOP_PX = 6

/**
 * Fast enough to be a throw rather than a placement, in pixels per second.
 *
 * Deliberately generous. A rider who flicks and expects the sheet to carry on is describing
 * intent; a rider inching it up to look at it is describing position. Only the first should
 * be allowed to overrule where the sheet actually got to.
 */
const FLICK_PX_PER_S = 500

/** Where a release settles when nothing was thrown: the nearer stop, with no hysteresis. */
const SETTLE = 0.5

/**
 * Whether a release was a press rather than a drag.
 *
 * The handle is a real button, so a press on it already produces a click — and a click is what
 * VoiceOver's activation and any synthetic press arrive as. Letting the pointer path toggle
 * too would toggle twice, so the caller uses this to stand aside and let the click through.
 * Off the handle there is no click to defer to, and a press is handled here.
 */
export function wasTap(travelledPx: number): boolean {
  return Math.abs(travelledPx) <= TAP_SLOP_PX
}

/**
 * How far between the two stops the sheet is, 0 at the card and 1 open.
 *
 * Clamped rather than rubber-banded. The open stop is the content's own height, so overshoot
 * would stretch a sheet past the thing it is drawn around and leave a strip of background
 * under the last row.
 */
export function sheetProgress({
  from,
  travelledPx,
  rangePx,
}: {
  from: SheetStop
  travelledPx: number
  rangePx: number
}): number {
  // Both stops in the same place — nothing has been measured yet, and the division would put
  // a NaN in a CSS variable, which drops every rule reading it rather than failing loudly.
  if (rangePx <= 0) return from === 'open' ? 1 : 0
  const start = from === 'open' ? rangePx : 0
  return Math.min(1, Math.max(0, (start + travelledPx) / rangePx))
}

/** Which stop a release lands on. */
export function sheetRelease({
  from,
  travelledPx,
  velocityPxPerS,
  rangePx,
}: {
  from: SheetStop
  travelledPx: number
  velocityPxPerS: number
  rangePx: number
}): SheetStop {
  // A tap toggles. The handle is the sheet's only permanent control, and a control that does
  // nothing when pressed is a control a rider stops believing in.
  if (wasTap(travelledPx)) return from === 'open' ? 'card' : 'open'

  // The direction of travel at the moment of release is the more recent statement of intent,
  // so it beats how far the sheet happened to get.
  if (Math.abs(velocityPxPerS) > FLICK_PX_PER_S) return velocityPxPerS > 0 ? 'open' : 'card'

  return sheetProgress({ from, travelledPx, rangePx }) >= SETTLE ? 'open' : 'card'
}
