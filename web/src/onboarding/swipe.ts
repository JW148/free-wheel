/**
 * The arithmetic behind swiping the first run.
 *
 * The six cards were always laid out as a carousel — one track, translated by index, with a row
 * of pips under it saying how many there are and which one you are on. Everything about that
 * says "swipe me", and nothing did: the only way through was the Next button. A rider who
 * swipes and gets nothing concludes the screen is stuck, not that they used it wrong.
 *
 * So the pips now tell the truth, and the buttons stay — they are the accessible path, the
 * discoverable one, and the only one a keyboard has.
 *
 * Pure, and in pixels rather than screen coordinates, for the same reason `sheetDrag.ts` is:
 * the part with a decision in it can be tested and the part with a pointer in it cannot. The
 * card is `overflow-y: auto` and the track moves in x, so the hard part is not the movement —
 * it is deciding, in the first dozen pixels, which of the two the rider meant.
 */

/** Under this in either axis, the finger has not yet said which gesture this is. */
const COMMIT_PX = 12

/** Fast enough to be a throw rather than a placement, in pixels per second. */
const FLICK_PX_PER_S = 450

/**
 * How far across the viewport a release has to have got to land on the next card.
 *
 * Well under half. A carousel is not a sheet: there is no cost to arriving on the wrong card
 * and the way back is the same gesture mirrored, so it should be easy rather than deliberate.
 */
const SETTLE = 0.28

/**
 * How much of a pull past the first or last card actually moves.
 *
 * Not zero. A dead edge reads as a broken screen; a heavy one reads as the end of the deck,
 * which is what it is.
 */
const EDGE_RESISTANCE = 0.3

/** What a press on a card has turned out to be. */
export type SwipeVerdict = 'wait' | 'swipe' | 'abandon'

/**
 * Whether a press has become a swipe, and if not, whether it still might.
 *
 * Mirrors `pendingVerdict` in `sheetDrag.ts`: nothing is captured and nothing moves until one
 * axis wins, so a press that turns out to be a tap on a bike chip is still that tap, and a
 * press that turns out to be a scroll down a long card is still that scroll.
 */
export function swipeVerdict(dxPx: number, dyPx: number): SwipeVerdict {
  if (Math.abs(dyPx) > Math.abs(dxPx) && Math.abs(dyPx) > COMMIT_PX) return 'abandon'
  if (Math.abs(dxPx) > COMMIT_PX) return 'swipe'
  return 'wait'
}

/**
 * How far the track should actually move, given how far the finger did.
 *
 * The identity in the middle of the deck; damped at either end, where there is no card to bring
 * on and the movement is only saying so.
 */
export function swipeOffsetPx(dxPx: number, index: number, last: number): number {
  const pullingPastStart = dxPx > 0 && index === 0
  const pullingPastEnd = dxPx < 0 && index === last
  return pullingPastStart || pullingPastEnd ? dxPx * EDGE_RESISTANCE : dxPx
}

/**
 * Which card a release lands on.
 *
 * A flick beats distance, for the reason it does on the sheet: the direction of travel at the
 * moment of release is the more recent statement of intent. Clamped to the deck, so the last
 * card's forward flick settles back rather than sliding the track off the end — finishing is
 * the button's job, and it is the one that asks for location.
 */
export function swipeRelease({
  index,
  last,
  dxPx,
  velocityPxPerS = 0,
  widthPx,
}: {
  index: number
  last: number
  dxPx: number
  velocityPxPerS?: number
  widthPx: number
}): number {
  const flicked = Math.abs(velocityPxPerS) > FLICK_PX_PER_S
  const far = widthPx > 0 && Math.abs(dxPx) / widthPx >= SETTLE
  // A flick and a drag can disagree about direction — the rider changed their mind on the way.
  // The flick is the later statement, so it decides which way as well as whether.
  const moved = flicked ? -Math.sign(velocityPxPerS) : far ? -Math.sign(dxPx) : 0
  return Math.min(last, Math.max(0, index + moved))
}
