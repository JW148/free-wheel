import type { ReactNode } from 'react'

import type { TurnKind } from './turns'

/**
 * The turn, as an arrow.
 *
 * ## Why a glyph and not just the words
 *
 * Everything else on the riding panel is read. This one is *recognised*, which is a different
 * and much cheaper act: a rider at 25 km/h glancing down has about a third of a second, and an
 * arrow bent to the left lands in that time where "Sharp left" has to be read. The words stay
 * next to it, because an arrow alone cannot say which exit.
 *
 * ## Why one construction rather than eleven drawings
 *
 * Every plain turn is the same figure at a different angle: a stem coming up from the bottom,
 * a corner, and a head. Drawing each one by hand means eleven chances for the arrowhead to sit
 * a pixel off or the stem to be a different length, and the set has to read as one family or
 * the angles stop being comparable. So the angle is the only input and the path is computed.
 *
 * The angles are BRouter's own distinctions: 35 degrees for a slight turn, 90 for a turn, 135
 * for a sharp one. They are not arbitrary and they are not evenly spread, because the thing
 * being drawn is what the road does.
 *
 * Three shapes are not that figure and are drawn on their own terms: the fork of a keep-left,
 * the loop of a U-turn, and the circle of a roundabout.
 *
 * ## Why the shape is shifted before it is drawn
 *
 * The construction is anchored at the stem's base, not at the middle: every figure runs from
 * y=21 up to wherever its head lands, so the taller the manoeuvre the higher it reaches and
 * the *ink* sits low in the box by a different amount for each kind. A right turn's ink is
 * centred 3.34 units below the viewBox's middle; a sharp right, whose head folds back down
 * beside its own stem, 4.5 — a fifth of the box, which is 6 px on the callout line and 13 on
 * the navigation page.
 *
 * Both places put the arrow in a flex row with `align-items: center`, so the *box* was
 * centred against the words perfectly and the arrow inside it was not — the words read as
 * floating above the turn. So each shape declares the vertical extent of what it actually
 * draws, and the group is translated to put that extent's middle on the box's middle.
 *
 * Per kind rather than one constant for the family: the error is 1 unit for a straight-on
 * arrow and 4.5 for a sharp turn, so a single shift would leave both ends of the set wrong
 * in opposite directions. The cost is that the stem's base moves a little as the turn
 * changes, which is invisible — nothing else on the panel shares that edge — where being a
 * sixth of a glyph out beside the words it belongs to is not.
 */

const SIZE = 24
/** Where the stem stops and the manoeuvre starts. Centre, a little above it. */
const CORNER = { x: 12, y: 12 }
/** The bottom of the stem: where every figure in the family starts from. */
const STEM = 21
const ARM = 7
const HEAD = 3.6

/**
 * A drawing, and the top and bottom of the ink in it.
 *
 * The span is stated beside the path it describes so the two cannot drift apart unnoticed —
 * and it is geometry only. The stroke is round-capped and the same width all round, so it
 * grows the ink equally at both ends and moves its middle nowhere.
 */
interface Shape {
  node: ReactNode
  span: [top: number, bottom: number]
}

/** Clockwise from straight ahead, in degrees, which is how a rider describes a turn. */
const ANGLES: Partial<Record<TurnKind, number>> = {
  straight: 0,
  'slight-left': -35,
  'slight-right': 35,
  left: -90,
  right: 90,
  'sharp-left': -135,
  'sharp-right': 135,
}

function arrow(degrees: number): { d: string; span: [number, number] } {
  const radians = (degrees * Math.PI) / 180
  const dx = Math.sin(radians)
  const dy = -Math.cos(radians)
  const tip = { x: CORNER.x + dx * ARM, y: CORNER.y + dy * ARM }

  // The two barbs, swept back 140 degrees either side of the direction of travel, so the head
  // stays the same shape whatever the angle underneath it.
  const barbAt = (sweep: number) => {
    const a = radians + (sweep * Math.PI) / 180
    return { x: tip.x - Math.sin(a) * HEAD, y: tip.y + Math.cos(a) * HEAD }
  }
  const barbs = [barbAt(-40), barbAt(40)]
  const point = (p: { x: number; y: number }) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`

  // A straight-on arrow has no corner to turn, so the stem simply runs into the head.
  const stem =
    degrees === 0
      ? `M${CORNER.x} ${STEM} L${point(tip)}`
      : `M${CORNER.x} ${STEM} V${CORNER.y} L${point(tip)}`

  // The stem's base is the lowest ink in every figure — the head can fold back beside it but
  // never past it — so only the top of the span has to be looked for.
  const ys = [tip.y, ...barbs.map((b) => b.y)]

  return {
    d: `${stem} M${point(barbs[0])} L${point(tip)} L${point(barbs[1])}`,
    span: [Math.min(...ys, CORNER.y), STEM],
  }
}

export default function TurnGlyph({ kind }: { kind: TurnKind }) {
  const { node, span } = shapeFor(kind)
  return (
    <svg
      className="turn-glyph"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`translate(0 ${shiftFor(span).toFixed(2)})`}>{node}</g>
    </svg>
  )
}

/** What the drawing has to move by for the middle of its ink to be the middle of the box. */
function shiftFor([top, bottom]: [number, number]): number {
  return SIZE / 2 - (top + bottom) / 2
}

function shapeFor(kind: TurnKind): Shape {
  const angle = ANGLES[kind]
  if (angle !== undefined) {
    const { d, span } = arrow(angle)
    return { node: <path d={d} />, span }
  }

  if (kind === 'keep-left' || kind === 'keep-right') {
    const left = kind === 'keep-left'
    // A fork, with the road not taken drawn faint. Both branches have to be there: the whole
    // instruction is that there are two and one of them is wrong.
    return {
      node: (
        <>
          <path className="turn-glyph-ghost" d={left ? 'M12 15 L17 9' : 'M12 15 L7 9'} />
          <path d={left ? 'M12 21 V15 L7 9 M7 13 V9 H11' : 'M12 21 V15 L17 9 M17 13 V9 H13'} />
        </>
      ),
      span: [9, 21],
    }
  }

  if (kind === 'u-turn') {
    // Up the right, round the top, back down the left, pointing where the rider came from.
    // The arc's own crown, 4 above the centre it turns about, is the top of the ink — not
    // either of the ends it is drawn between.
    return { node: <path d="M16 21 V13 A4 4 0 0 0 8 13 V18 M5 15 L8 18 L11 15" />, span: [9, 21] }
  }

  if (kind === 'roundabout') {
    // The island, the approach, and the way out. Which exit is in the words beside it — six
    // glyphs for six exit numbers would be six things to recognise instead of one.
    return {
      node: (
        <>
          <circle cx="12" cy="10" r="4" />
          <path d="M12 21 V14 M16 10 H20 M17 7 L20 10 L17 13" />
        </>
      ),
      span: [6, 21],
    }
  }

  if (kind === 'end') {
    // A flag on a post. The finish, not a manoeuvre.
    return { node: <path d="M8 21 V4 M8 5 H17 L14.5 8.5 L17 12 H8" />, span: [4, 21] }
  }

  // `beeline` and anything a future BRouter adds. A dash rather than an invented instruction.
  return { node: <path d="M7 12 H17" />, span: [12, 12] }
}
